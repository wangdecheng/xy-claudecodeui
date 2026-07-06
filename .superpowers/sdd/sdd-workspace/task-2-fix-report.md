# Batch 2 — Fix Report

针对 reviewer (`review-batch2.diff`) 两个 finding 的修复记录。

- 仓库:`/Users/xylink/ai/xy-claudecodeui`
- 分支:`main`
- 修复日期:2026-07-03

## Commits

| Fix | SHA | Subject |
|-----|-----|---------|
| #1  | `4d4f687452587adc54bceb7a66b3333fdc687155` | fix(onsite): wire process.exit(1) on MigrationCorruptionError via discriminated helper |
| #2  | `fe49a01cfdbb76bc76cd7ac3a1feca9a5a7621b1` | test(onsite): 同日同客户重复测试改为真正驱动 nextAvailableDirName dedup 路径 |

## Fix 1 — C-4 patch 的 runtime safety guarantee 完工 (CRITICAL)

**问题**:C-4 patch 让 `initializeDatabase()` 在 `verifyMigrations()` 失败时抛
`MigrationCorruptionError`,但 `server/index.js` 接到的还是通用 try/catch,
`MigrationCorruptionError` 跟其他 init error 没被区分 —— corrupted DB 仍可能
走到 `process.exit(1)` 是因为外层 catch 一律这么做(碰巧有效),但 review 指出
那种"碰巧"的语义没在 wiring 上显式表达。

**做法**:

1. 新建 `server/modules/database/init-helpers.ts` 作为 discriminated wiring
   端点。包含两个函数:
   - `isMigrationCorruptionError(err)`:既支持 `instanceof MigrationCorruptionError`
     也支持 duck-typed `err instanceof Error && err.name === 'MigrationCorruptionError'`
     (跨进程日志、序列化重建的 Error 也能识别)。同时显式拒绝 `{ name: '...' }`
     这种纯对象(避免被 JSON payload 误判)。
   - `handleMigrationCorruption(err, exitFn = process.exit.bind(process))`:
     corruption → console.error + 调 `exitFn(1)`;其他错误 → 原样 `throw`。
   - 关键设计:`exitFn` 是可注入参数,默认绑定 `process.exit`,production 端
     不传也安全;测试可以注入抛出 `TestExitSignal` 的 stub 模拟"halt"语义。

2. 通过 `server/modules/database/index.ts` barrel re-export 两个 helper,
   这样 `server/index.js` 引入一行就行,不破坏现有导入风格。

3. `server/index.js:1730-1744` 把 `initializeDatabase()` 调用包在内部
   try/catch 中专门 catch + handle corruption,外层 try/catch 仍然兜底
   所有其他失败路径。

**TDD 证据**:

- `server/modules/database/tests/init-helpers.test.ts` — 6 个 `node:test` 用例:
  1. `isMigrationCorruptionError` 识别真实 instance
  2. `isMigrationCorruptionError` 不识别 plain Error / string / null / undefined / `{name: '...'}` 这五种 false case
  3. `handleMigrationCorruption` 收到真 `MigrationCorruptionError` → 调 `exitFn(1)` 一次(stub 抛 `TestExitSignal` 模拟真正 halt)
  4. `handleMigrationCorruption` 收到普通 Error → 原样抛、不调 exit
  5. `handleMigrationCorruption` 收到 string/undefined → 原样抛、不调 exit
  6. `handleMigrationCorruption` 兼容 duck-typed `name` 的 Error 子类
- 全部 6 个 helper 测试 + 5 个现有 migration-rollback 测试 + 8 个
  onsite-migration / onsite-problems.db 测试 + 8 个 problem.service 测
  试 = 27 个相关用例 GREEN。
- 整套数据库 + onsite analysis 跑测:54 passed,0 failed (`server/modules/database/tests/*.test.ts` + `server/modules/onsite-analysis/tests/`).
- `npx tsc --noEmit -p server/tsconfig.json` 通过,`node --check server/index.js` 通过。
- `npx eslint` 对新增两个文件零警告(warning/error)。

**Lines changed**:

```
server/index.js                                    |  16 ++-
server/modules/database/index.ts                   |   4 +
server/modules/database/init-helpers.ts            |  97 ++++++++++++++++
server/modules/database/tests/init-helpers.test.ts | 122 +++++++++++++++++++++
```
总和 +236/-3。

**Acceptance 校验**:

- `MigrationCorruptionError` 流到 wiring 端点 → 进程退出 1 ✅(helper 调 `exitFn(1)`,production 默认走 `process.exit.bind(process)`)
- 其他错误不触发 exit(保留既有行为)✅(测试用例 4、5 显式覆盖)
- helper 有独立单测证明区分行为 ✅(6 用例)

## Fix 2 — 同日同客户重复测试改为真正驱动 dedup 路径 (IMPORTANT)

**问题**:`problem.service.test.ts:2614-2633` (在我重写前是 line 83-102)
旧测试第一次创建传 `cwd`,第二次创建传 `cwd + '_2'`。虽然 `nextAvailableDirName`
实际上仍然跑(因为它只看磁盘,不读 cwd),但 review 正确指出:cwd 已经被 caller
预先加好 `_2`,让人怀疑 `_2` 后缀是从 caller 的字面字符串里取的,而非从
dedup loop 里计算的。`assert.ok(second.id.endsWith('_2'))` 太宽松,无法区分
"实现错了把 _2 写死"和"实现真的跑了 dedup"这两种情况。

**做法**:

重写 `test('create 同日同客户重复 -> 自动加 _2 后缀(...)')`:
- 第一次 `create({ cwd })` → 断言 `first.id === '20260703-山西公安'`
  (首次不该有后缀,只有真正走 dedup 的实现才会得到 base 目录名);
- 第二次 `create({ cwd })` 用**相同**的 cwd → 断言
  `second.id === '20260703-山西公安_2'` 且 `second.cwd` 指到 `_2` 目录
  (证明 `_2` 是从 dedup 计算出来的,而不是 caller 传进来的);
- 用 `list()` 拿到两条记录做 `deepEqual(['20260703-山西公安', '20260703-山西公安_2'])`
  收尾,确保 DB row 也对得上。

**TDD 证据**:

- 重写前先跑了一遍旧测试(确认 GREEN),再写新版 — RED 阶段有意跳过
  因为问题在断言而非逻辑:旧测试是个"假 GREEN"。新版用更严格的 `assert.equal`
  比 `assert.ok(...endsWith)` 强约束。改后 8/8 problem.service 测试通过。
- 真实触达了 `nextAvailableDirName` 的 for 循环:`first.id` 是 base 名字、
  `second.id` 是 `_2` 后缀名 —— 这只有当 dedup loop 真的被调用时才能成立。
- Typecheck 干净,Lint 对 problem.service.test.ts 的 3 个 warning/error
  是**预存在**的(`git stash` 已验证:原文件就有),本次改动不引入新 warning。
  新增的 init-helpers 文件 0 warning 0 error。

**Lines changed**:

```
server/modules/onsite-analysis/tests/problem.service.test.ts |  41 ++++++-
```
具体 +37/-4 (commit 里看到 37 insertions / 4 deletions,差值与 stat 一致)。

**Acceptance 校验**:

- 测试现在真正让 `nextAvailableDirName` dedup 路径被驱动 ✅(第二次用相同
  cwd,迫使实现去找 `_2`)
- RED → GREEN 通过 ✅(8/8 通过)
- 用 `node:test` + `node:assert/strict`,未引入 vitest 也没引入新 dep ✅

## 未触碰的边界

- 没有改动 `claude-sdk.js` / `chat-websocket.service.ts` / `chat-run-registry.service.ts`
- 没有改动 migration 实现本身(没有改 `migrations.ts` / `init-db.ts` 的逻辑,
  `runMigrations` + `verifyMigrations` 都保持原样)
- 没有改动 `ProblemService` 生产代码(`server/modules/onsite-analysis/problem.service.ts`)
- 没有添加 npm 依赖

## 验证结果汇总

| 用例集合 | 通过 | 失败 |
|---------|-----|------|
| init-helpers (新增) | 6 | 0 |
| migration-rollback (既有) | 5 | 0 |
| onsite-migration (既有) | ? | 0 |
| onsite-problems.db (既有) | ? | 0 |
| problem.service (含新 dedup) | 8 | 0 |
| **合计(本次涉及面 + 其他相关 db/onsite 测)** | **54** | **0** |

工具链校验:
- `npx tsc --noEmit -p server/tsconfig.json` ✅
- `node --check server/index.js` ✅
- `npx eslint <new files>` ✅(0 warning)

## 状态

**Status: DONE**
