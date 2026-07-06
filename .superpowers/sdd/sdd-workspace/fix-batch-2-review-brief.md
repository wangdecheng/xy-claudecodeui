# Comprehensive Fix Brief — Checkpoint Review Batch 0~2

> 来源:`.superpowers/sdd/sdd-workspace/checkpoint-review-batch0-2.md`
> 范围:`6a88025..72c8725`(17 commits, 42 files)
> 用户指令:"C" = 修所有 Critical + Important,然后进 Batch 3
> 模式:SDD,单 implementer 处理 6 个修复,每项 TDD 纪律
> 报告:`.superpowers/sdd/sdd-workspace/fix-batch-2-review-report.md`

## 总览

| # | 严重度 | 文件 | 修复 |
|---|---|---|---|
| C-1 | Critical | `server/modules/database/migrations.ts:683-688` | 删除 step 1 SHA placeholder(改为方案 2 — 移除 sessions kind migration step,因 ALTER 不便 hash) |
| I-1 | Important | `scripts/regression-chat.sh:166-168` | awk sum → `tail -n1` last-value 解析 |
| I-3 | Important | `server/modules/onsite-analysis/config.service.ts:72-74` | `resolveConfigPath` 后接 `path.normalize` |
| I-5 | Important | `server/modules/onsite-analysis/tests/config.route.test.ts:81-90` | 收紧断言 `>= 500 && < 600` → `=== 503` |
| I-6 | Important | `server/modules/database/repositories/onsite-problems.db.ts:87-94` | rename `updateStatus` → `updateStatusOnly`,移除 `_reason` / `_actorId` 死参数(契约:audit 由调用方 `onsiteStateAuditDb.append` 写) |
| I-9 | Important | `server/modules/database/repositories/sessions.db.ts` + 新文件 | `assertSessionKind(value)` app-layer 守卫,`InvalidSessionKindError`,wrap createSession / createAppSession |

## 必读文件

1. **完整 review 报告**:`.superpowers/sdd/sdd-workspace/checkpoint-review-batch0-2.md`(尤其是 Issues 段)
2. **migrations.ts**:第 500-720 行(已读过)
3. **config.service.ts**:整文件(已读过)
4. **onsite-problems.db.ts**:整文件(已读过)
5. **sessions.db.ts**:整文件(已读过)
6. **schema.ts**:第 99-130 行(kind CHECK)
7. **现有 migration 测试**:`server/modules/database/tests/onsite-migration.test.ts`(参考测试模式)
8. **现有 sessions 测试**:`server/modules/database/tests/sessions.db.integration.test.ts`(参考 assertKind 放置位置)
9. **现有 config route 测试**:`server/modules/onsite-analysis/tests/config.route.test.ts`
10. **现有 onsite-problems 测试**:`server/modules/database/tests/onsite-problems.db.test.ts`

## TDD 纪律

每项修复遵循 RED-GREEN-REFACTOR:

1. **RED**:写/改测试断言目标行为(如:`assert.equal(status, 503)` / `assert.throws(...)` for assertKind)
2. **跑测试,确认 RED**: `cd /Users/xylink/ai/xy-claudecodeui && node_modules/.bin/tsx --test --tsconfig server/tsconfig.json <test-file>`
3. **GREEN**:实现最小代码改动
4. **跑测试,确认 GREEN**:同文件 + 全量回归
5. **REFACTOR**:清理(若有)

## 修复规范

### C-1: 删除 step 1 SHA placeholder

**现状**(migrations.ts:682-708):
```ts
const ONSITE_MIGRATION_STEPS: MigrationStep[] = [
  {
    name: '001_add_sessions_kind_and_onsite_columns',
    sql: 'ADD COLUMN kind / cwd / third_bridge_branch / iteration / database',  // ← placeholder
    sha: '',
  },
  { name: '002_create_onsite_problems_table', sql: ONSITE_PROBLEMS_TABLE_SCHEMA_SQL, sha: '' },
  { name: '003_create_onsite_files_table', sql: ONSITE_FILES_TABLE_SCHEMA_SQL, sha: '' },
  { name: '004_create_onsite_state_audit_table', sql: ONSITE_STATE_AUDIT_TABLE_SCHEMA_SQL, sha: '' },
  { name: '005_create_onsite_discipline_log_table', sql: ONSITE_DISCIPLINE_LOG_TABLE_SCHEMA_SQL, sha: '' },
];
```

**修复方案**:删除 step 1(方案 2 — sessions 表基础结构在 `INIT_SCHEMA_SQL`,ALTER 步骤不参与 SHA 跟踪)。需在 `addSessionsKindAndOnsiteColumns` 上方加 JSDoc 说明该 ALTER 不被 integrity check 覆盖,以及为什么 ALTER 不便 hash。

**测试**:写一个新测试 `server/modules/database/tests/onsite-migration.test.ts` 或扩展现有,断言:
- `ONSITE_MIGRATION_STEPS` 长度 === 4(原 5)
- 第一个 step 的 name 是 `002_create_onsite_problems_table`(原 `001_add_sessions_kind_and_onsite_columns`)
- 所有 step 的 sha 都不是空字符串

**额外**:在 `verifyMigrations` 函数上加 JSDoc,说明 step 1 缺失的设计意图(sessions 表在 INIT_SCHEMA_SQL,ALTER 不参与 SHA 跟踪)。

### I-1: regression-chat.sh last-value 解析

**现状**(scripts/regression-chat.sh:166-168):
```bash
PASS_COUNT="$(grep -E '^ℹ +(tests|pass)' "$TMP_OUT" | awk '/pass/ { gsub(/[^0-9]/, "", $NF); sum += $NF } END { print sum+0 }')"
TESTS_COUNT="$(grep -E '^ℹ +tests' "$TMP_OUT" | awk '{ gsub(/[^0-9]/, "", $NF); sum += $NF } END { print sum+0 }')"
FAIL_COUNT="$(grep -E '^ℹ +fail' "$TMP_OUT" | awk '{ gsub(/[^0-9]/, "", $NF); sum += $NF } END { print sum+0 }')"
```

**修复**:改为取最后一个匹配行(全局总汇,而非每个文件):
```bash
PASS_COUNT="$(grep -E '^ℹ +pass' "$TMP_OUT" | tail -n1 | awk '{ gsub(/[^0-9]/, "", $NF); print $NF+0 }')"
TESTS_COUNT="$(grep -E '^ℹ +tests' "$TMP_OUT" | tail -n1 | awk '{ gsub(/[^0-9]/, "", $NF); print $NF+0 }')"
FAIL_COUNT="$(grep -E '^ℹ +fail' "$TMP_OUT" | tail -n1 | awk '{ gsub(/[^0-9]/, "", $NF); print $NF+0 }')"
```

**测试**:在 `scripts/tests/regression-chat.test.ts` 加一个新测试,模拟 TMP_OUT 包含多条 `ℹ pass` / `ℹ fail` 行(多文件),断言最后一行被取用。

### I-3: resolveConfigPath 加 path.normalize

**现状**(config.service.ts:72-74):
```ts
function resolveConfigPath(input: string): string {
  return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
}
```

**修复**:
```ts
function resolveConfigPath(input: string): string {
  const resolved = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
  return path.normalize(resolved);
}
```

**测试**:在 `server/modules/onsite-analysis/tests/config.service.test.ts`(或 watch.test.ts)加测试,传入带 `./` 或 `../` 的相对路径,断言返回路径已 normalize。

### I-5: 收紧 config 路由测试到 503

**现状**(config.route.test.ts:81-90):
```ts
test('GET /api/onsite/config returns 503/500 when config not loaded', async () => {
  resetConfig();
  const app = buildApp();
  const response = await request(app).get('/api/onsite/config');
  // Accept either 500 or a custom 503 — implementation choice. Must NOT be 200.
  assert.ok(response.status >= 500 && response.status < 600, `expected 5xx, got ${response.status}`);
  assert.ok(response.body.error || response.body.message);
});
```

**修复**:断言严格 `=== 503`。同时保留 body error/message 检查。

### I-6: rename updateStatus → updateStatusOnly

**修复**:
- `server/modules/database/repositories/onsite-problems.db.ts:87-94`: rename method,移除 `_reason` / `_actorId` 参数,签名变 `(id: string, status: string): void`
- `server/modules/database/tests/onsite-problems.db.test.ts:101-107`: 更新调用,断言 `updateStatusOnly`
- 新增 JSDoc 明确:audit row 必须由调用方通过 `onsiteStateAuditDb.append(...)` 单独写(后续 Batch 3 StateMachine 应在 `db.transaction` 中合并两写以保证原子性,但本 fix 仅清理 contract)

**测试**:
- 现有测试改用新名字
- 新增测试:`updateStatusOnly` 拒绝多余参数(如果 TS 严格,直接 compile 失败也算测试)

### I-9: sessionsDb app-layer assertKind 守卫

**修复方案**:
1. 在 `server/modules/database/repositories/sessions.db.ts` 顶部加:
   ```ts
   export type SessionKind = 'chat' | 'onsite';
   
   export class InvalidSessionKindError extends Error {
     readonly code = 'INVALID_SESSION_KIND';
     readonly kind: unknown;
     constructor(kind: unknown) {
       super(`Invalid session kind: ${JSON.stringify(kind)} (must be 'chat' or 'onsite')`);
       this.name = 'InvalidSessionKindError';
       this.kind = kind;
     }
   }
   
   function assertSessionKind(value: unknown): asserts value is SessionKind {
     if (value !== 'chat' && value !== 'onsite') {
       throw new InvalidSessionKindError(value);
     }
   }
   ```
2. 在 `createSession(providerSessionId, provider, projectPath, customName, createdAt, updatedAt, jsonlPath)` 末尾,DB insert 之前,显式 `assertSessionKind('chat')`(保持向后兼容 — 默认 chat)
3. 在 `createAppSession` 也显式 `assertSessionKind('chat')`
4. (可选)新增一个 `createOnsiteSession` 方法供 Batch 4/5.5 用:
   ```ts
   createOnsiteSession(sessionId: string, provider: string, projectPath: string, opts: { cwd: string; third_bridge_branch: string | null; iteration: string; database: string }): string {
     assertSessionKind('onsite');
     // ...INSERT with kind='onsite', cwd, third_bridge_branch, iteration, database
   }
   ```
   这正好响应 review 的 F-2 forward-looking 风险。

**测试**:
- `assertSessionKind('bogus')` throws InvalidSessionKindError
- `assertSessionKind('chat')` / `assertSessionKind('onsite')` 不抛
- 集成测试:`createOnsiteSession` 创建带 onsite 列的行,`findOnsiteSessionByCwd` 能找到

### Progress.md 整理

**目标文件**:`.superpowers/sdd/progress.md`

**修改**:
1. 在 Batch 2 后的 follow-up 区域,新增 `### 后续 follow-up(Critical 1 条 + Important 已修)`
2. 把 SHA placeholder 从 Batch 2 follow-up 的 Minor 提升为 Critical,**标注已修(本 fix 批次)**
3. 删除 I-2:CRITICAL_PATTERNS sessions 缺 / — 标注 "实际正确,从 follow-up 移除"
4. I-4 bootstrap race 与 I-8 listeners.clear global — 标注 "Deferred with rationale"
5. 新增本批次 fix commits 记录

## 提交规范

本批次每个修复 1 个 commit(共 6 个 commit),最后 1 个 commit 整理 progress.md。

格式(用户规范):
- `fix(onsite): [C-1] 删除 step 1 SHA placeholder,改为只 SHA 真 CREATE TABLE`
- `fix(onsite): [I-1] regression-chat.sh 改 last-value 解析(防多文件 double-count)`
- `fix(onsite): [I-3] config.service resolveConfigPath 加 path.normalize`
- `test(onsite): [I-5] 收紧 config 路由测试到 503(原 5xx 范围)`
- `refactor(onsite): [I-6] rename updateStatus → updateStatusOnly 明确契约`
- `feat(onsite): [I-9] sessionsDb app-layer assertSessionKind 守卫 + createOnsiteSession + findOnsiteSessionByCwd`
- `docs(sdd): progress.md 整理:promote C-1, remove I-2, document I-4/I-8`

每个 commit 前跑 `node_modules/.bin/tsx --test --tsconfig server/tsconfig.json <changed-test-file>` 确认绿色,最后一个 commit 前跑全量 server 测试确认无回归。

## 完成标准

1. 所有 6 个修复完成,代码 + 测试 + commit + report
2. 全量测试通过:`cd /Users/xylink/ai/xy-claudecodeui && node_modules/.bin/tsx --test --tsconfig server/tsconfig.json "server/**/*.test.{ts,js}" "server/*.test.{ts,js}"` exit 0
3. Chat 路径零回归:pass/fail 计数与基线 `chat-regression-baseline.txt:1` 一致(78/1,允许 pre-existing 1 fail)
4. Report 写到 `.superpowers/sdd/sdd-workspace/fix-batch-2-review-report.md`
5. **不要再继续 Batch 3**(本次只做 fix)

## 失败模式(STOP 信号)

- TDD 跳过 RED 直接写代码 → 回 RED
- 多个修复混合在 1 个 commit → 拆分
- 改了未在 brief 范围的文件 → 撤销 + 报告
- 全量测试有 fail → 修复直到绿(不能带 fail 提交)

## 报告格式

写到 `.superpowers/sdd/sdd-workspace/fix-batch-2-review-report.md`:

```markdown
# Fix Report — Checkpoint Review (Batches 0~2)

## Status
[ DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED ]

## Commits
列出 7 个 commit hash + 标题

## Tests
- 全量测试结果(总 pass / fail)
- Chat 路径回归:pass/fail vs baseline

## Fix 清单(每项 3-5 行)
### C-1
- 文件:line
- 改动摘要
- 测试断言

### I-1 ... I-9

## Concerns (可选)
若有任何不确定 / 需要后续 fix 的项

## Next Step Suggestion
推荐下一步(若 status === DONE,推荐 "Ready for reviewer subagent")
```