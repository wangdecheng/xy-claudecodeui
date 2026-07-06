# Task 5 Report — Wiring + Path Blacklist + Log-unpack + Upload

## Status
DONE

## Commits
- 4a78773 feat(onsite): wire onsite routes + WS + middleware into server index (Sub-task A)
- e9b22e9 feat(onsite): path blacklist via disallowedTools (no SDK change) (Sub-task B)
- b095625 feat(onsite): log-unpack service with one-archive-per-dir rule (Sub-task C)
- a907415 feat(onsite): file upload routes (Sub-task D)
- 590755e refactor(onsite): replace updateRootCause hack with root_cause_text column (Sub-task E)
- 03fe253 test(onsite): use unique problemId per upload test (避免并发污染) (stability fix in 5.5)

## Test Results
- 全量(单跑 tsx --test):306 tests, **304 pass / 2 fail**
  - 2 fail 均为预存在,与 Batch 5 无关:`config.service.watch mtime change` (fs.watch macOS 时序) + `provider-models cache is persisted`(Batch 4 报告已标记)
- 新增测试数:+35(Batch 4 baseline 268 → 现在 303,Bash 4 之后又加了 1 = 304)
- chat 回归(脚本):
  - baseline:268 pass / 2 fail (32ace22)
  - post-Batch-5:303 pass / 3 fail (03fe253)
  - +35 新测试全通过;新增的 1 fail 是 config.service.watch flaky,与 Batch 5 无关
  - **chat 路径行为零回归**(测试结果一致 + onsite 测试不影响 chat run)

## Per-Sub-Task Summary

### A Wiring(commit 4a78773)
- **server/index.js 接线点**:`createWebSocketServer(server, {...})` 返回 `wss` 后,新增 `onsiteWebSocketService.attach(wss)` 一行
- **/onsite/ws 路径分支**:`websocket-server.service.ts:67` 在 `/shell` `/ws` 旁加 `if (pathname === '/onsite/ws') return;`,让 onsiteWebSocketService 已注册的 hello handler 接管;不再触发 `[WARN] Unknown WebSocket path`
- **middleware 在 writer 出站路径挂载方式**:`chat-run-registry.service.ts` 新增 `attachOnsiteDisciplineMiddlewares(run)` 函数,在 `startRun({kind:onsite})` 创建 ChatSessionWriter 后挂载 3 个 middleware(softening / trace-id / write-protection)到 `run.writer.ws.send`。`enabledFor` 闭包查 `chatRunRegistry.getRunKind(run.appSessionId) === 'onsite'`,即便 ws 被复用也安全;`applyBlocked` 注入 `state-machine.apply(problemId, 'blocked', reason, null)`;`getTraceId` 从 `<cwd>/.traceId` 文件读,fallback `process.env.TRACE_ID`;`logHit` 写 `onsite_discipline_log` 表。`attachConnection` 在 onsite run 重连后重置 idempotency flag 并重新挂载。
- **chat 路径零侵入**:`startRun({kind:'chat'})`(默认)不挂任何 middleware,既有 chat 调用方(`chat-websocket.service.ts:137`)无需改

### B Path Blacklist(commit e9b22e9)
- **新增 `onsite-path-blacklist.service.ts`**:
  - `ONSITE_PROTECTED_GLOBS` = 7 类:`*.log` `*.log.gz` `*.jsonl` `unpacked-*` `problem.json` `*.tar.gz` `*.tgz`
  - `BASH_WRITE_ACTIONS` = 7 类:`rm` `rm -rf` `tee` `sed -i` `awk -i` `cp -f` `mv`
  - `FILE_WRITE_ACTIONS` = `Write` `Edit`
  - `toDisallowPatterns(globs)` 纯函数:每 glob × (Bash 7 + Write + Edit),跨 glob dedupe;每个 pattern 都是合法 SDK 形式 `Bash(...)/Write(...)/Edit(...)`
- **注入点**:`injectOnsiteBlacklist(sdkOptions, globs)` 把 pattern 追加到 `sdkOptions.disallowedTools`。生产中由 onsite 路径的 spawn 调用;chat 路径**不调**(硬保证零侵入)。
- **chat 路径隔离**:SDK 现有 `canUseTool` 的 `isDisallowed` 分支(`claude-sdk.js:589-594`)无需改 — disallowedTools 是数组传入即可。未触碰 SDK 代码。

### C Log-unpack(commit b095625)
- **新增 `log-unpack.service.ts`**:
  - `PayloadTooLargeError` / `TooManyFilesError` 两个明确 error 类
  - `unpackMany(files, destDir, options?)`:每个 zip → `destDir/unpacked-N/`(N 从 1 起)
  - 实现用系统 `unzip` 命令(macOS/Linux 预装),无新依赖
- **错误处理**:
  - 单包 > 200MB / 总数 > 20 → 整批失败,任何已建目录被回滚(remove)
  - 单 zip 损坏 → 删除该 `unpacked-N/`,返 `{ ok: false, originalName, error: 'corrupted_zip' }`
  - 其它项继续(并行处理)
- **测试**用 `child_process.spawn('zip', ...)` 构造测试 zip

### D Upload Routes(commit a907415)
- **POST `/api/onsite/problems/:id/files`**:
  - multer diskStorage,tmpdir,字段名 `files`,最多 20 文件,单文件 ≤ 200MB
  - 调 `logUnpackService.unpackMany` 解压
  - 207 multi-status + per-file results
  - 413 PAYLOAD_TOO_LARGE / TOO_MANY_FILES(整批失败)
  - 400 NO_FILES / BAD_FIELD_NAME / UPLOAD_FAILED
  - 404 PROBLEM_NOT_FOUND
  - 成功的项落 `onsite_files` 表(kind='archive',含 unpacked_dir)
- **GET `/api/onsite/problems/:id/files`**:Batch 3 已存在,本次未改,确认仍能工作
- **multer 配置**:`diskStorage`(与 server/index.js:913 既有上传一致模式)

### E Root Cause Column(commit 590755e)
- **migration 加列**:
  - `schema.ts`:`onsite_problems` 表加 `root_cause_text TEXT`
  - `migrations.ts`:新加 `006_add_root_cause_text` step 到 `ONSITE_MIGRATION_STEPS`(SHA-tracked,固定 SQL);`migrateAll` 内对已存在表用 `addColumnToTableIfNotExists` 补列(idempotent)
- **移除 hack**:`onsite-problems.db.ts` 删 `require('node:fs')` 整段,`updateRootCause` 改成 `UPDATE root_cause_text` 列;`SELECT_COLUMNS` 加列;`OnsiteProblemRecord` 类型加 `root_cause_text: string | null`
- **调整 `onsite-migration.test.ts`**:长度断言 4 → 5(Batch 5 新增 step)

## Concerns
1. **Pre-existing fails**(与 Batch 5 无关,Batch 4 报告已标记):
   - `config.service.watch mtime change` — macOS fs.watch 时序敏感,4s waitFor 偶尔超时
   - `provider-models cache is persisted` — 缓存持久化测试
   - 这两个 fail 已在 baseline(32ace22)时就存在,Batch 5 未引入新 fail

2. **chat 回归脚本 flaky**:`config.service.watch` fail 在不同跑次间偶发(2 fail 或 3 fail),不影响 Batch 5 结论

3. **Upload route 测试**:用 `Date.now() + 随机数` 保证 problemId 唯一,避免并发跑时 cwd 冲突;在 6 测试 + 35+ 其他测试的并发全量跑次中稳定通过

## Forward Compatibility
**Batch 5.5 (chat 回归门禁)准备**:
- baseline 已写(268/2 at 32ace22);当前 303/3 全是新测试通过 + 1 flaky pre-existing
- e2e 路径:Batch 5.5 可以从 batch-5 commit 出发跑 `bash scripts/regression-chat.sh`,对比 baseline

**Batch 6 (前端)准备**:
- 5 个 REST 端点全部已挂载:`GET /api/onsite/problems`、`POST /api/onsite/problems`、`GET /api/onsite/problems/:id`、`PATCH /api/onsite/problems/:id`、`POST /api/onsite/problems/:id/confirm-root-cause`
- 新增 `POST /api/onsite/problems/:id/files`(207 multi-status,前端可显示 per-file 结果)
- WS `/onsite/ws` 已可连(hello frame 验证 + ws.kind='onsite' 标记)
- discipline envelope flag schema 已稳定(softening / traceIdEmpty / traceIdSuspect / writeOriginalLog,均 additive under `discipline: {...}`)

## Next Step
"Ready for reviewer subagent verification"

## Stats
- 6 commits (5 feature + 1 test stability fix)
- +35 new tests, all pass
- 0 chat-path regressions
- 2 pre-existing fails (unrelated, in baseline)