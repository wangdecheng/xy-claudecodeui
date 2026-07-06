# Task 4 Report — WS Integration + Discipline Middlewares

## Status
DONE_WITH_CONCERNS

## Commits
- 264e645 feat(onsite): OnsiteWebSocketService with kind-aware routing
- d289b63 feat(onsite): discipline-softening middleware
- c311e2c feat(onsite): confirm-root-cause blocks on softening words
- 82a4fe3 feat(onsite): discipline-trace-id middleware with multi-signal auto-blocked
- b04bcee feat(onsite): discipline-trace-id suspect signal (non-blocking)
- 32ace22 feat(onsite): write-protection middleware

## Test Results
- 全量:268 pass / 2 fail(全部 6 个子任务完成,所有新增 60 个测试通过)
- 新增测试数:+60(157 → 217 全量;268 pass 包括 Batch 1-3)
- 2 个 fail 均为预存在(config.service.watch mtime 时序问题 + provider-models cache 持久化),与 Batch 4 无关
- chat 路径零回归:chat-run-registry、chat-websocket 既有测试全部通过

## Per-Sub-Task Summary

### 4.1 OnsiteWebSocketService
- 实现要点:`chat-run-registry.service.ts` 的 `ChatRun` 加 `kind` 字段(默认 'chat'),
  暴露 `getRunKind(appSessionId)`;新增 `onsite-websocket.service.ts`,提供
  `validateOnsiteHelloFrame` 纯函数 + `attach(wss)` 挂载 hello-frame 验证器到
  `/onsite/ws` 路径;`/onsite/ws` 与 chat 共享底层 `wss` 实例但走独立 hello 验证
  流程(首帧必须是 `{ kind: 'onsite', problemId, cwd, userId }`,否则 `ws.close(4001, reason)`)
- 集成点:`attach(wss)` 接到 `websocket-server.service.ts` 已有的 `wss.on('connection')`
  路由(`/onsite/ws` → 走 hello 验证 → 后续 chat 协议复用);验证通过后 `ws.kind = 'onsite'`
  + `ws.onsite = { problemId, cwd, userId }`,给 Batch 4 中间件用

### 4.2 Softening
- 词库来源:`config/discipline-words.json`(15 词中英文对照)
- 命中行为:assistant 文本含词 → 落 `onsite_discipline_log(kind=softening)` +
  envelope 加 `discipline.softening = true` + `words: [{word, position}]` flag;
  不改 content;`replaceForUi` 是 UI 渲染辅助

### 4.3 Confirm-root-cause
- 422 触发条件:`root_cause_text` 含软化词(共享 4.2 的 `findWords`)
- 400 触发条件:`reason` < 8 字符 或 `root_cause_text` 空
- 404 触发条件:`problemId` 不存在
- 200 成功:StateMachine.apply(id, 'confirmed', reason, actorId) + broadcast + root_cause 写入 disk(problem.json)

### 4.4.a TraceId main
- 多信号触发:`grep|rg|ag|ack '<traceId>'` 0 命中(强)或 assistant 文本含
  `未找到|0 结果|no matches|...` 且过去 60s 内有 grep(主)
- 自动 blocked:命中 → ctx.applyBlocked → StateMachine.apply(id, 'blocked', ...)
- 防误报:主信号只在"60s 内 grep 过同一 traceId"时触发;traceId 来源于 ctx.getTraceId(ws)

### 4.4.b TraceId suspect
- 弱信号触发:`cat|head|tail|wc|xxd|find|python3?|node` + 空 stdout
- 不 blocked:仅落 `onsite_discipline_log(kind=trace_id_suspect)` + emit
  `'discipline:trace-id-suspect'` + envelope `discipline.traceIdSuspect=true` flag

### 4.5 Write-protection
- 双正则:WRITE_ACTION_REGEX(`rm|rm -rf|tee|cp -f|mv|sed -i|awk -i|>`) + 
  ORIGINAL_PATH_REGEX(`*.log|*.log.gz|*.jsonl|*.tar.gz|*.tgz|problem.json|unpacked-*`)
- 软审计:命中 → 落 `onsite_discipline_log(kind=write_protection)` + emit
  `'discipline:write-protection-detected'` + envelope `discipline.writeOriginalLog=true` flag
- 不调 StateMachine.apply(纯记录)

## Concerns
**非阻塞**:Batch 4 内新代码全部通过(60/60 测试);但全量 server 测试有 2 个预存在 fail:
1. `config.service.watch.test.ts:mtime change triggers callback` — fs.watch 在 macOS 上时序敏感,4 秒 waitFor 超时
2. `providers/provider-models.service.test.ts:provider model cache is persisted` — 与 Batch 4 无关的 cache 持久化逻辑

Batch 5 入口已就绪:
- 硬层 `disallowedTools`(SDK path blacklist) + 软层 `write-protection` 正交
- discipline envelope flag 已有 schema,可直接接前端 toast(Batch 6)
- 6 个 ws.kind='onsite' 路径中间件共享 `enabledFor(ws)` 模式,后续易扩展

**潜在阻塞(轻)**:OnsiteWebSocketService 仅做了 hello 验证 + 标记 ws.kind,
没有真正把 hello 上下文透传给 chat-run-registry 的 `startRun`(后续 chat.send
仍按 chat 协议走,problemId 通过 sessionId 关联)。Batch 5/6 接 SDK 路径时需确认
discipline 中间件能稳定拿到 problemId(测试中通过 `envelope.problemId` 字段
兜底,production 路径尚需 Batch 5 接线验证)。

## Forward Compatibility
Batch 5 (SDK path blacklist + log-unpack):
- 硬层 disallowedTools + 软层 write-protection 双层就位
- Blacklist 是 Path.blacklist 模式,与 write-protection 的两正则正交
- Batch 6 (frontend) 准备:discipline envelope flag 已有 schema

## Next Step
"Ready for reviewer subagent verification"