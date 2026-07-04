# Progress Ledger: customer-onsite-analysis-ui

> 跟踪 spec-superflow SDD 执行进度。
> 每完成一个 Task + review 干净,追加一行。

| Task | 状态 | Commits | 备注 |
|------|------|---------|------|
| Task 0.1 | complete(review approved) | 14af19b | `scripts/regression-chat.sh` + 5 个测试;real run: 78 pass / 1 fail / 8862 ms |
| Task 0.2 | complete(review approved) | 14af19b + 9318b69 | `scripts/diff-chat-impact.sh` + 5 个测试 + `.github/workflows/regression.yml` |
| Task 1.1 | complete(review approved) | (含 1.2 commit) | `config/discipline-words.json` + `config/json-schemas/customer-analysis.schema.json`(`config/customer-analysis.json` 已存在) |
| Task 1.2 | complete(review approved) | 6ecbb22 | `server/modules/onsite-analysis/config.service.ts` + 7 个测试 |
| Task 1.3 | complete(review approved) | a3ab84d | mtime watch + hot-reload + 5 个测试 |
| Task 1.4 | complete(review approved) | b6ef14d | `onsite.routes.ts` + `GET /api/onsite/config` + 4 个测试 + `bootstrapConfig` 注入 `server/index.js` |
| Task 2.1 | complete(review approved) | 3ceef87 | `sessions` 表加 5 列 + 5 个新表 + 5 测试 |
| Task 2.1.b | complete(review approved) | a231023 | C-4 migration 事务 + `verifyMigrations` + SHA 跟踪 + 5 测试 |
| Task 2.2 | complete(review approved) | c9f4897 | 4 个 onsite repository + 16 测试 |
| Task 2.3 | complete(review approved) | f9dce87 | `ProblemService` + `CwdEscapeError` + 同日重复 `_2` 后缀 + 8 测试 |
| Task 2.4 | complete(review approved) | ba39760 | chokidar OnsiteWatcher + 1s debounce + 4 测试 |
| Task 2.fix.1 | complete(review approved) | 4d4f687 | **Critical 修复**:`handleMigrationCorruption` + `server/index.js` 接通 `process.exit(1)` |
| Task 2.fix.2 | complete(review approved) | fe49a01 | **Important 修复**:同日重复测试真正驱动 `nextAvailableDirName` 路径 |
| Task 2.fix.review.1 | complete(review approved) | dae2e5d | **Critical 修复(C-1)**: 删除 step 1 SHA placeholder,改为只 SHA 真 CREATE TABLE(4 步而非 5 步) |
| Task 2.fix.review.2 | complete(review approved) | 31b6482 | **Important 修复(I-1)**: `regression-chat.sh` 改 last-value 解析,防多文件 double-count |
| Task 2.fix.review.3 | complete(review approved) | 52703b1 | **Important 修复(I-3)**: `config.service.ts` `resolveConfigPath` 加 `path.normalize` |
| Task 2.fix.review.4 | complete(review approved) | 19890dc | **Important 修复(I-5)**: config 路由测试收紧到 `=== 503`(原 5xx 范围) |
| Task 2.fix.review.5 | complete(review approved) | 26409a0 | **Important 修复(I-6)**: `updateStatus` → `updateStatusOnly`,移除死参数 `_reason` / `_actorId` |
| Task 2.fix.review.6 | complete(review approved) | 6aa6aae | **Important 修复(I-9)**: `sessionsDb` 加 app-layer `assertSessionKind` 守卫 + `createOnsiteSession` + `findOnsiteSessionByCwd`(同时覆盖 review F-2 forward-looking 风险) |

## Review Verdict — Batch 2

- **Verdict**: ✅ Approved(re-review 通过)
- **First review**: 1 Critical + 4 Important + 5 Minor
- **Critical fixed**: `process.exit(1)` 已接通,`MigrationCorruptionError` discriminator 健壮(`instanceof` + duck-typed)
- **Important #2 fixed**: 同日重复测试现在真正调用 `nextAvailableDirName` dedup 循环
- **Remaining 3 Important + 5 Minor** 记为 follow-up

### 后续 follow-up(Critical 1 条已修 + Important 3 条已修 + 遗留 1 条)

**批 2 后,Checkpoint Review (Batch 0~2 复审) 处置结果(共 6 个修复):**

1. **(已修,本批次) C-1**: 删除 step 1 SHA placeholder(迁移 C-4 完整性检查最大盲点)— `dae2e5d`
2. **(已修,本批次) I-1**: `regression-chat.sh` `awk sum` → `tail -n1` last-value 解析,防多文件 TAP 输出 double-count — `31b6482`
3. **(已修,本批次) I-3**: `config.service.ts:resolveConfigPath` 加 `path.normalize`,下游 path 比较获得稳定 canonical 形式 — `52703b1`
4. **(已修,本批次) I-5**: `config.route.test.ts` 断言收紧 `>= 500 && < 600` → `=== 503`,未来回退到 500/502/504 立即暴雷 — `19890dc`
5. **(已修,本批次) I-6**: `onsite-problems.db.ts:updateStatus` → `updateStatusOnly`,移除 `_reason` / `_actorId` 死参数,JSDoc 明确 audit row 由调用方 `onsiteStateAuditDb.append(...)` 写(Batch 3 StateMachine 应整合到同一 `db.transaction`) — `26409a0`
6. **(已修,本批次) I-9**: `sessionsDb` 加 `assertSessionKind` / `InvalidSessionKindError` / `createOnsiteSession` / `findOnsiteSessionByCwd`,app-layer 升级路径下守护 `kind` 完整性,同时为 Batch 4 / Batch 5.5 提供 forward-looking 接口 — `6aa6aae`

### 后续 follow-up(Important 1 条遗留 + Minor 6 条)

1. **(遗留,不再独立跟踪)**: `findLatestPendingAppSession` 的 `provider_session_id IS NULL` 假设在 Batch 5.5 起就需要重新审 — 等到 Batch 4/5 时再 review
2. `if (!step.sha) step.sha = sha256(step.sql)` 是 dead-code 防御检查(SHA 现在总是 computed at load)
3. `sha256` 每次模块加载都重算(可缓存,但只在测试修改 SQL 常量时才有意义)
4. `verifyMigrations` failure message 拼装可优化
5. 测试中 `db.exec as typeof db.exec` 类型 cast fragile
6. `dflt_value` 单引号兼容性 cosmetic
7. `DEBOUNCE_MS` 硬编码

### 后续 follow-up(继承自之前批次,显式 deferred)

**I-4 (`config.service.bootstrapConfig` race with watch)**: **Deferred with rationale** — 窗口小,影响仅在 bootstrap 返回与 chokidar 首次 attach 之间,典型单服务器不会遇到。Batch 5 (WS 路径黑名单,需要更精细的 path-watch) 重新 review 时一并处理。如需提前解决:实现 "watcher before load" — 即在 chokidar 注册但 `ignoreInitial: true`,待 `ready` 后才允许 emit。

**I-8 (`OnsiteWatcher.listeners.clear()` 全局清理)**: **Deferred with rationale** — 测试目前是串行,即便 Batch 5.5 把测试分散到多个 file,Node 24 默认还是 sequential。`--test-concurrency > 1` 才需要修,而该 flag 当前未启。建议 Batch 8 验收前 pre-disable 并加 telemetry 暴露 "I cleared listeners from N test contexts" 日志。

## Review Verdict — Batch 1

- **Verdict**: ✅ Approved
- **Critical**: 0
- **Important**: 4(全部为卫生级,非阻塞,记为 cleanup follow-up)
- **Minor**: 6(可后续 follow-up)

### 后续 follow-up(Important 4 条)

1. `customer-analysis.schema.json` `additionalProperties: true` 顶层过宽
2. `ajv` 走 transitive dep,应显式加到 `dependencies`
3. `_setConfigForTests` 公开导出可被生产代码误用
4. `watchConfig` 单 watcher 约束未在 API 层强制

### 后续 follow-up(Minor 6 条)

- `_comment` 字段是 schema 收紧后的潜在 landmine
- 503 fallback 在 `onsite.routes.ts` 是 over-engineering
- `onConfigChange` 初始 bootstrap 不触发订阅(应加 JSDoc)
- 测试名小写 + 部分缺 assertion message
- 内部 `await import('node:fs/promises')` 冗余
- 4 个文件缺 trailing newline

## Review Verdict — Batch 0

- **Verdict**: ✅ Approved
- **Critical**: 0
- **Important**: 4(全部为健壮性,非阻塞)
- **Minor**: 7(可后续 follow-up)

### 后续 follow-up(Important 4 条)

1. `regression-chat.test.ts` race condition in baseline-restore test cleanup
2. `regression-chat.sh` 用 `awk sum` 而非 last-value 解析多文件测试输出(fragile)
3. `diff-chat-impact.sh` word-splitting via unquoted `${BASE_SHA}..${HEAD_SHA}`(lint warning)
4. Workflow yml step 1 exit handling inconsistency(实际无害)

### 后续 follow-up(Minor 7 条 → 现 6 条)

- `tsx --test` reporter ℹ 符号变化会 break 解析 → 考虑 `--test-reporter=tap`
- `case "--nonsense*)` 是 dead code
- `bash` 硬编码(WIN 不友好)
- 无 `shellcheck` CI step
- placeholder commit SHA 不可达
- 无 `--version`
- ~~`CRITICAL_PATTERNS` 中 `sessions` 缺 `/`~~ **删除**:review 复审确认实际正确(case-statement 展开依赖全字匹配 `server/modules/database/repositories/sessions*.ts`),无需修改。这就是 review brief 中的 I-2 — 已从 follow-up 移除。

## Review Verdict — Batch 1

- **Verdict**: ✅ Approved
- **Critical**: 0
- **Important**: 4(全部为卫生级,非阻塞,记为 cleanup follow-up)
- **Minor**: 6(可后续 follow-up)

### 后续 follow-up(Important 4 条)

1. `customer-analysis.schema.json` `additionalProperties: true` 顶层过宽(应 `false` + 白名单 `_comment`)
2. `ajv` 走 transitive dep,应显式加到 `dependencies`
3. `_setConfigForTests` 公开导出可被生产代码误用
4. `watchConfig` 单 watcher 约束未在 API 层强制

### 后续 follow-up(Minor 6 条)

- `_comment` 字段是 schema 收紧后的潜在 landmine
- 503 fallback 在 `onsite.routes.ts` 是 over-engineering
- `onConfigChange` 初始 bootstrap 不触发订阅(应加 JSDoc)
- 测试名小写 + 部分缺 assertion message
- 内部 `await import('node:fs/promises')` 冗余
- 4 个文件缺 trailing newline

## Review Verdict — Batch 0

- **Verdict**: ✅ Approved
- **Critical**: 0
- **Important**: 4(全部为健壮性,非阻塞)
- **Minor**: 7 → 现 6 条(已删除 I-2)

### 后续 follow-up(Important 4 条 → 现 3 条)

1. `regression-chat.test.ts` race condition in baseline-restore test cleanup
2. ~~`regression-chat.sh` 用 `awk sum` 而非 last-value 解析多文件测试输出(fragile)~~ **已修(本批次 fix 2,I-1)**
3. `diff-chat-impact.sh` word-splitting via unquoted `${BASE_SHA}..${HEAD_SHA}`(lint warning)
4. Workflow yml step 1 exit handling inconsistency(实际无害)

## 状态

- **Workflow**: `full`
- **Mode**: `SDD`
- **Contract**: 已批准(2026-07-03)
- **Batches Completed**: 0 / 9(Batch 0~8;Batch 5.5 后置)
- **当前 commit**: latest on `main`(见 git log 顶部,本批次 6 commits 后)
- **Pre-existing failure**: `provider-models.service.test.ts` 在 main 上 fail(与 chat 路径无关);`problem.service.test.ts` 两条同日同客户测试依赖"今天的日期"、跨天会 fail(Batch 5.5 baseline diff 会捕获,Batch 8 验收前需 fix with date-freezing 或 ephemeral cwd)

## Review 节点

- [x] Batch 0 收尾 → 进 Batch 1
- [ ] Batch 2 收尾 → 进 Batch 3(schema 改动不可逆)
- [ ] Batch 4 收尾 → 进 Batch 5(纪律护栏核心)
- [ ] Batch 5.5 收尾 → 进 Batch 6(chat 回归门禁)
- [ ] Batch 7 收尾 → 进 Batch 8
- [ ] Batch 8 收尾 → 进 release-archivist
