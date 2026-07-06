# Task 3 Report — StateMachine + REST routes + Broadcast

## Status
DONE_WITH_CONCERNS

## Commits
- eeddca4 feat(onsite): state machine with table-driven transitions + transactional apply
- 53651da feat(onsite): REST routes for problems + state machine
- a06c08e feat(onsite): onsite state broadcast channel

## Test Results
- 全量:209 pass / 2 fail(基线 157/1,本 batch 新增 +52 测试全部 pass)
- 新增测试数:52(state-machine 28 + routes 14 + broadcast 10)

## Implementation Notes

### Task 3.1
- 5 状态定义,10 条显式合法迁移(覆盖 `*→abandoned`,`abandoned` 是终态)
- `canTransition` 是纯函数,返回 discriminated union `{ok:true}` | `{ok:false, allowed}`
- `apply` 用 `db.transaction(() => {updateStatusOnly + audit append})()` 包裹两个 DB 写,再独立同步 problem.json(失败不抛、记 warn,沿用 D-3 disk-as-truth 语义)
- reason 校验在事务前,先 trim 再比 ≥ 8 字符
- 自定义 error:`InvalidStateTransitionError` / `ReasonTooShortError` / `ProblemNotFoundError`,带 `code` 字段供路由层翻译
- 关键决策:
  1. problem.json 同步在事务外(因为是 fs IO,不适合包进 SQLite transaction;失败只 warn 不回滚 DB — D-3 允许)
  2. `at` 时间戳从 audit 表 `listByProblemId` 的最后一行读回(SQLite `CURRENT_TIMESTAMP` 提供规范化 UTC)
  3. audit append 抛错会被 `db.transaction` 自动捕获并回滚 status 更新

### Task 3.2
- 5 个端点:
  1. `GET /api/onsite/problems` — `problemService.list()` 按 `STATUS_ORDER` (blocked→analyzing→pending_info→confirmed→abandoned) 排序
  2. `POST /api/onsite/problems` — 必给字段 (400) → customer 在 config (422) → ProblemService.create (409 CwdEscapeError)
  3. `GET /api/onsite/problems/:id` — 走 `problemService.getById`
  4. `PATCH /api/onsite/problems/:id` — reason < 8 → 400,NotFound → 404,非法迁移 → 409 + `allowed` 数组,成功 → broadcast + 200
  5. `GET /api/onsite/problems/:id/files` — `onsiteFilesDb.findByProblemId`
- 排序:app-side sort(用 STATUS_ORDER 表 + 比较函数),不在 SQL 里 CASE WHEN,避免 SQL 字符串模板难维护
- 错误翻译:在 catch 块里 `instanceof` 错误类,提取 `.code` / `.allowed` 等结构化字段进响应体
- 关键决策:
  1. PATCH route 用 `.then`/`.catch` 而非 `async/await`,避免 Express 5 对 unhandled rejection 的行为差异
  2. 422 错误码 — REST 语义:格式合法但业务规则不通过
  3. 401 测试用真 `authenticateToken` 中间件,其它测试用 shim 注入假 user

### Task 3.3
- `onsiteBroadcast` 单例:`Set<Subscriber>` + `subscribe/unsubscribe/broadcast/subscriberCount/_resetForTests`
- `BroadcastEvent` 是 discriminated union,`state-changed` 用 template literal type 保证 id 出现在 type 里
- `broadcast` 内部 try/catch per-subscriber — 一个抛错不影响其他
- `OnsiteWatcher` → `onsiteBroadcast` 集成在 `server/index.js` boot:启动 watcher 后注册 `onWatcherChange(() => broadcast({type: 'problems:changed'}))`
- shutdown 路径也加 `stopOnsiteWatcher()` 配合 `closeSessionsWatcher()`
- 关键决策:
  1. 进程内 pub/sub(单服务进程足够),不引入 Redis pub/sub
  2. `_resetForTests()` 显式测试 hook,生产代码禁止调用(命名带下划线 + 注释)
  3. EventPayload 用 template literal type:`problem:${string}:state-changed`,把 id 编进 type 里,避免宽松的 string

## Concerns

1. **Pre-existing test flakiness(2 个失败与本 batch 无关)**:
   - `server/modules/onsite-analysis/tests/config.service.watch.test.ts` 的 "mtime change triggers callback" — chokidar awaitWriteFinish 在某些时序下超时(4s waitFor)
   - `server/modules/providers/tests/provider-models.service.test.ts` 的 "provider model cache is persisted across service instances" — loader 被多调一次,缓存未命中预期
   - 这两个测试在 batch 0/1/2 时期已是基线问题(基线 157/1,现 209/2),与 onsite StateMachine/Routes/Broadcast 改动无关,建议 reviewer 阶段确认是否需要修复

2. **apply() 事务边界的 trade-off**:
   - DB 事务只包 `updateStatusOnly + audit append`
   - problem.json 同步在事务外、读 → 改 → 写失败只记 warn
   - 极端情况:DB 写成功 + problem.json 同步失败 → DB 是 status 真相,disk 暂时落后,`list()` 重新读 json 时会发现不一致;下一次 `apply()` 会重新覆盖 json,自动修复
   - 选择这条路是因为 fs IO 不适合包进 SQLite transaction(跨资源);若要求严格一致,需要引入 outbox 模式或两阶段提交

3. **REST 路由对 customer 校验依赖 config 已加载**:
   - POST `/problems` 在 config 未加载时返 503(CONFIG_NOT_LOADED)
   - 当前架构下 config 必须先 bootstrap(server boot 路径已保证),测试用 `_setConfigForTests` 注入

## Forward Compatibility

Batch 4 (WebSocket + 中间件) 准备:
- `StateMachine.apply` 接受 actorId=null — 系统 actor 可走(`tests/state-machine.test.ts` 已覆盖)
- `onsiteBroadcast.subscribe` 已暴露 — WebSocket handler 用 `ws.send` 实现 `Subscriber` 接口即可接入
- broadcast event type 用 template literal — 新增 `problem:<id>:files-changed` 等类型只需扩 union
- 401 测试用真 `authenticateToken` 中间件 — Batch 4 加 WebSocket auth 时可参考同样模式

## Next Step
"Ready for reviewer subagent verification"