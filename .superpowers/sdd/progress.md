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

## Review Verdict — Batch 2

- **Verdict**: ✅ Approved(re-review 通过)
- **First review**: 1 Critical + 4 Important + 5 Minor
- **Critical fixed**: `process.exit(1)` 已接通,`MigrationCorruptionError` discriminator 健壮(`instanceof` + duck-typed)
- **Important #2 fixed**: 同日重复测试现在真正调用 `nextAvailableDirName` dedup 循环
- **Remaining 3 Important + 5 Minor** 记为 follow-up

### 后续 follow-up(Important 3 条)

1. 升级 DB 上 `sessions.kind` 缺 CHECK(只能新建表生效,升级路径无应用层校验)
2. `if (!step.sha) step.sha = sha256(step.sql)` 是 dead-code 防御检查
3. `sha256` 每次模块加载都重算(可缓存)

### 后续 follow-up(Minor 5 条)

- `ONSITE_MIGRATION_STEPS[0].sql` 是占位字符串,新增列时不会触发 SHA 漂移
- `verifyMigrations` failure message 拼装可优化
- 测试中 `db.exec as typeof db.exec` 类型 cast fragile
- `dflt_value` 单引号兼容性 cosmetic
- `DEBOUNCE_MS` 硬编码
- `listeners.clear()` 全局 singleton(测试 ordering 敏感)
- 弱 `assert.ok(calls >= 1 && calls <= 3)` 应记录 trade-off
- `resolveOnsiteRoot` lazy 调用文档缺失

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

### 后续 follow-up(Minor 7 条)

- `tsx --test` reporter ℹ 符号变化会 break 解析 → 考虑 `--test-reporter=tap`
- `case "--nonsense*)` 是 dead code
- `bash` 硬编码(WIN 不友好)
- 无 `shellcheck` CI step
- placeholder commit SHA 不可达
- 无 `--version`
- `CRITICAL_PATTERNS` 中 `sessions` 缺 `/`

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
- **Minor**: 7(可后续 follow-up)

### 后续 follow-up(Important 4 条)

1. `regression-chat.test.ts` race condition in baseline-restore test cleanup
2. `regression-chat.sh` 用 `awk sum` 而非 last-value 解析多文件测试输出(fragile)
3. `diff-chat-impact.sh` word-splitting via unquoted `${BASE_SHA}..${HEAD_SHA}`(lint warning)
4. Workflow yml step 1 exit handling inconsistency(实际无害)

### 后续 follow-up(Minor 7 条)

- `tsx --test` reporter ℹ 符号变化会 break 解析 → 考虑 `--test-reporter=tap`
- `case "--nonsense*)` 是 dead code
- `bash` 硬编码(WIN 不友好)
- 无 `shellcheck` CI step
- placeholder commit SHA 不可达
- 无 `--version`
- `CRITICAL_PATTERNS` 中 `sessions` 缺 `/`

## 状态

- **Workflow**: `full`
- **Mode**: `SDD`
- **Contract**: 已批准(2026-07-03)
- **Batches Completed**: 0 / 9(Batch 0~8;Batch 5.5 后置)
- **当前 commit**: `9318b69`(Batch 0 done)
- **Pre-existing failure**: `provider-models.service.test.ts` 在 main 上 fail(与 chat 路径无关);Batch 5.5 baseline diff 会捕获此 fail 计数,Batch 8 验收前需修

## Review 节点

- [x] Batch 0 收尾 → 进 Batch 1
- [ ] Batch 2 收尾 → 进 Batch 3(schema 改动不可逆)
- [ ] Batch 4 收尾 → 进 Batch 5(纪律护栏核心)
- [ ] Batch 5.5 收尾 → 进 Batch 6(chat 回归门禁)
- [ ] Batch 7 收尾 → 进 Batch 8
- [ ] Batch 8 收尾 → 进 release-archivist
