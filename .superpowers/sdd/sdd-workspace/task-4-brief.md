# Batch 4 Brief — WebSocket 集成 + 纪律中间件

> **范围**:`tasks.md § Batch 4`(Tasks 4.1 / 4.2 / 4.3 / 4.4.a / 4.4.b / 4.5;4.4.c 前端留 Batch 6)
> **Spec**:`specs/discipline-trace-id.md` REQ-8.x + `specs/discipline-write-protection.md` REQ-9.x + `specs/issue-state.md` REQ-3.x
> **Design**:design.md §D-7.1 / D-7.2 / D-7.3 + D-9(multi-signal traceId)
> **依赖**:Batch 2(`OnsiteWatcher`, `sessionsDb.createOnsiteSession`, `OnsiteDisciplineLog`) + Batch 3(`StateMachine.apply`, `OnsiteBroadcast`)
> **Working directory**:`/Users/xylink/ai/xy-claudecodeui`
> **报告**:`.superpowers/sdd/sdd-workspace/task-4-report.md`
> **预计 commits**:6(每子任务 1 个)+ 可能的接线 commit

## 已有资产(不要重写)

- `server/modules/onsite-analysis/state-machine.service.ts`:`apply(problemId, to, reason, actorId)`
- `server/modules/onsite-analysis/onsite-broadcast.ts`:`subscribe(sub) / unsubscribe / broadcast(event) / subscriberCount()`
- `server/modules/onsite-analysis/problem.service.ts`:`problemService.create / list / getById / sanitizeCustomerLabel / CwdEscapeError / assertCwdUnderRoot`
- `server/modules/database/repositories/onsite-displiplog.db.ts`:`onsiteDisciplineLogDb.append({ problem_id, message_id, kind, word, position, cmd, stdout_preview }) / listByProblemId / countByProblemId`
- `server/modules/database/repositories/sessions.db.ts`:`createOnsiteSession / findOnsiteSessionByCwd`
- `server/modules/websocket/services/chat-websocket.service.ts`:已有 chat WS 路径,4.1 要**复用 / 拓展**而非重写
- `server/modules/websocket/services/chat-run-registry.service.ts`:已有 `startRun / getRun / isProcessing / completeRun`,4.1 加 `kind` 字段
- `config/discipline-words.json`:15 软化词(`可能 / 大概 / 也许 / 似乎 / 看起来 / 或许 / 大致 / 应该 / 估计 / 应该 / 感觉 / 我觉得 / might / probably / maybe`)

---

## Task 4.1 — `OnsiteWebSocketService` + `kind` 字段

### 改 `chat-run-registry.service.ts`

- `startRun(input)` 加可选 `kind?: 'chat' | 'onsite'`,默认 `'chat'`,写到 `runs.get(appSessionId).kind`
- 暴露 `getRunKind(appSessionId): 'chat' | 'onsite' | undefined`
- **不**改 chat 调用处(chat 不传 kind,默认 'chat')

### 新增 `server/modules/websocket/services/onsite-websocket.service.ts`

```ts
export const onsiteWebSocketService = {
  /**
   * 注册 /onsite/ws 路径(独立于 chat WS,但复用底层 ws.Server)
   * 首帧必须 { kind: 'onsite', problemId, cwd, userId }
   * 验证失败 → ws.close(4001, reason)
   * 验证通过 → 把 cwd 注入 chat-websocket.service 的 spawn options
   *           然后通过 chatRunRegistry.startRun 启动 run(带 kind='onsite')
   *           后续消息透传 chat WS 处理逻辑(但挂载 Batch 4 middlewares)
   */
  attach(wss: WebSocketServer): void;
  
  /** 测试用:拆掉 handler */
  detach(): void;
};
```

### 验证逻辑(独立函数,易测)

```ts
function validateOnsiteHelloFrame(frame: unknown):
  | { ok: true; payload: { problemId: string; cwd: string; userId: string | null } }
  | { ok: false; reason: string };

// 验证步骤
// 1. JSON 解析成功 + 是 object
// 2. frame.kind === 'onsite'
// 3. frame.problemId 是非空字符串
// 4. frame.cwd 是绝对路径且 assertCwdUnderRoot(cwd) 通过
// 5. frame.userId 可选(string | null)
// 任意失败 → { ok: false, reason: '<原因>' }
```

### Tests(≥ 8 个)

```ts
test('validateOnsiteHelloFrame: kind=onsite 合法', ...);
test('validateOnsiteHelloFrame: 缺 kind 拒绝', ...);
test('validateOnsiteHelloFrame: kind=chat 拒绝', ...);
test('validateOnsiteHelloFrame: problemId 空拒绝', ...);
test('validateOnsiteHelloFrame: cwd=/etc 拒绝(越界)', ...);
test('chatRunRegistry.startRun kind 默认 chat', ...);
test('chatRunRegistry.startRun kind=onsite 写入', ...);
test('chatRunRegistry.getRunKind 返 chat/onsite/undefined', ...);
test('OnsiteWebSocketService.attach 注册 ws path(集成)', ...);
```

### Commit
`feat(onsite): OnsiteWebSocketService with kind-aware routing`

---

## Task 4.2 — 软化词扫描中间件

### 新增 `server/modules/onsite-analysis/discipline/discipline-softening.middleware.ts`

```ts
type SofteningMatch = { word: string; position: number };
type DisciplineContext = { enabledFor: (ws: WsClient) => boolean; logHit: (entry: SofteningLogEntry) => void };

export const disciplineSofteningMiddleware = {
  /** Pure: 给定文本,返回所有软化词命中(供 Task 4.3 共用) */
  findWords(text: string): SofteningMatch[];
  containsSoftening(text: string): boolean;
  /** 把命中词替换为 <softening word="X" position="N"/>原词 */
  replaceForUi(text: string): string;
  
  /** 挂在 ws.send: 拦截 outgoing assistant 消息,扫描 content,落日志 + flag */
  attachToWs(ws: WsClient, ctx: DisciplineContext): void;
};

type SofteningLogEntry = {
  problemId: string;
  messageId?: string;
  word: string;
  position: number;
  kind: 'softening';
};
```

**词库从 `config/discipline-words.json` 读**(lazy load,避免循环依赖)。

### 关键设计

- 中间件**只挂**到 `enabledFor(ws) === true` 的 ws(`ws.kind === 'onsite'`)
- 不修改 chat 消息
- 落 `onsite_discipline_log` 表,kind='softening'
- 修改 outgoing assistant 消息 envelope,加 `discipline: { softening: true, words: [...] }` flag(不改 content,只加 flag — Task 4.3 才会真替换用于「确认为已证实」拦截)

### Tests(≥ 7 个)

```ts
test('findWords("可能") 返回命中', ...);
test('findWords("this might be") 英文命中', ...);
test('findWords("safe text") 空数组', ...);
test('containsSoftening true/false', ...);
test('replaceForUi 把命中词替换为 <softening> tag', ...);
test('attachToWs 仅在 enabledFor=true 时挂载', ...);
test('命中落 onsite_discipline_log(kind=softening)', ...);
test('assistant 消息 envelope 加 discipline.softening flag', ...);
test('chat 路径不挂载(enabledFor(ws)=false)', ...);
```

### Commit
`feat(onsite): discipline-softening middleware`

---

## Task 4.3 — `confirm-root-cause` 端点拦截软化词

### Modify `onsite.routes.ts`

新增 `POST /api/onsite/problems/:id/confirm-root-cause`:

```ts
// body: { root_cause_text: string, reason: string }
// 验证:
// 1. root_cause_text 非空
// 2. reason >= 8 字符
// 3. !disciplineSofteningMiddleware.containsSoftening(root_cause_text)
//    否则 422 { error: 'softening_words_present', words: [...] }
// 4. 验证通过 → StateMachine.apply(id, 'confirmed', reason, userId)
//    + broadcast('problem:<id>:state-changed')
//    + (可选)落 root_cause 到 problem.json 新字段
```

### Tests(≥ 4 个)

```ts
test('POST confirm-root-cause 含软化词返 422 + words 列表', ...);
test('POST confirm-root-cause 干净文本 + 合法 reason 返 200 + audit', ...);
test('POST confirm-root-cause reason < 8 字符返 400', ...);
test('POST confirm-root-cause 成功后 broadcast state-changed', ...);
```

### Commit
`feat(onsite): confirm-root-cause blocks on softening words`

---

## Task 4.4.a — traceId 主信号 + 强信号(自动 blocked)

### 新增 `server/modules/onsite-analysis/discipline/discipline-trace-id.middleware.ts`

```ts
const MAIN_SIGNAL_REGEX = /(未找到|0\s*结果|no matches|found nothing|无命中|没有结果|no results?)/i;
const GREP_FAMILY_CMD_REGEX = /^\s*(grep|rg|ag|ack)\b/;

type TraceIdContext = {
  enabledFor: (ws: WsClient) => boolean;
  /** 当前 ws/problem 的 traceId(cwd 下 .traceId 文件读出) */
  getTraceId: (ws: WsClient) => string | null;
  /** emit 后调 StateMachine.apply */
  applyBlocked: (problemId: string, reason: string) => Promise<void>;
  /** 落 onsite_discipline_log */
  logHit: (entry: TraceIdLogEntry) => void;
};

export const disciplineTraceIdMiddleware = {
  attachToWs(ws: WsClient, ctx: TraceIdContext): void;
};
```

### 检测逻辑

**主信号**(AI assistant 文本扫描):
- 监听 outgoing `assistant` 消息,content 字符串匹配 `MAIN_SIGNAL_REGEX`
- **前提**:必须在过去 60 秒内出现过 `grep <traceId>` 命令(`grepFamilyRecently` state per-ws)
- 命中 → emit + flag

**强信号**(tool_result):
- 监听 `tool_result` 消息,识别 `command` 字段是 `(grep|rg|ag|ack) ... '<traceId>'` + stdout 全部 `0` 行
- 命中 → emit

### 命中行为

```ts
// 1. 落 onsite_discipline_log(kind='trace_id_empty', problem_id, word=matchedText, cmd=triggerSource)
// 2. 修改 envelope: assistant message 加 discipline: { traceIdEmpty: true, matchedText }
// 3. emit('discipline:trace-id-empty')  — onsite-broadcast channel
// 4. await ctx.applyBlocked(problemId, autoReason)  // StateMachine.apply(id, 'blocked', ...)
//    autoReason: `[traceId] ${traceId} 在 ${cmd} 中 0 命中(${matchedText})@${ISO} — 见 CLAUDE.md 第 N 章`
```

**chat 路径不挂载**(`enabledFor(ws) === false`)。

### Tests(≥ 9 个)

```ts
// 主信号
test('AI 文本含"未找到" + 之前有 grep traceId → emit + flag traceIdEmpty=true', ...);
test('AI 文本含"0 结果" + grep → emit', ...);
test('AI 文本含"no matches" + grep → emit(英文)', ...);
test('AI 文本含"未找到" 但无 grep 历史 → 不 emit(防误报)', ...);
test('AI 文本含"未找到" 但 grep traceId 不匹配实际 traceId → 不 emit', ...);

// 强信号
test('grep -rc traceX 返 0 → emit', ...);
test('rg traceX 0 命中 → emit', ...);
test('ag traceX 0 命中 → emit', ...);
test('ls 命令不触发(非 grep 家族)', ...);

// 后续行为
test('emit 后调 StateMachine.apply 切 blocked', ...);
test('autoReason 包含 traceId + 触发源 + ISO 时间', ...);
test('chat 路径 enabledFor=false 不挂载', ...);
test('envelope discipline.traceIdEmpty flag 设置', ...);
```

### Commit
`feat(onsite): discipline-trace-id middleware with multi-signal auto-blocked`

---

## Task 4.4.b — traceId 弱信号(suspect,非 blocked)

### Modify `discipline-trace-id.middleware.ts`(同文件)

加 `detectSuspect(ws, msg)`:

**触发条件**:tool_result 中非 grep 家族的"0 命中"操作:
- `cat <empty_file>` → stdout 空
- `find . -type f | wc -l` → 返 0
- `python3 -c "open('empty').read()"` → stdout 空
- `head <empty_file>` / `tail <empty_file>` → stdout 空
- `wc -l <empty_file>` → 0
- `xxd <empty_file>` → 仅头部

**命中行为**:
1. 落 `onsite_discipline_log(kind='trace_id_suspect', problem_id, cmd, stdout_preview=前 200 字, at)`
2. emit `'discipline:trace-id-suspect'`
3. 修改 envelope: assistant 消息加 `discipline: { traceIdSuspect: true, cmd }` flag
4. **不**调 StateMachine.apply(不自动 blocked)

### Tests(≥ 5 个)

```ts
test('cat foo.log(空文件)→ 落 suspect 日志 + flag, 不调 StateMachine', ...);
test('find . -name "*.log" 无结果 → suspect,不 blocked', ...);
test('python3 -c "open(\'empty\').read()" 返空 → suspect', ...);
test('head/tail/wc 空文件 → suspect', ...);
test('suspect 事件不调 StateMachine.apply', ...);
test('suspect 日志含 cmd + stdout preview(前 200 字)+ at', ...);
```

### Commit
`feat(onsite): discipline-trace-id suspect signal (non-blocking)`

---

## Task 4.5 — write-protection 软审计中间件

### 新增 `server/modules/onsite-analysis/discipline/discipline-write-protection.middleware.ts`

```ts
const WRITE_ACTION_REGEX = /\b(rm|rm\s+-rf|tee|cp\s+-f|mv|cat\s+.*>|sed\s+-i|awk\s+-i|>\s*[^&|])/;
const ORIGINAL_PATH_REGEX = /(?:^|\s|\/|\\)([^\\\/\s]+\.(log|log\.gz|jsonl|tar\.gz|tgz)|problem\.json|unpacked-[\w-]+)(\s|$|\/|\\)/;

export const disciplineWriteProtectionMiddleware = {
  /** Pure: 检测命令是否同时命中写动作 + 原始日志路径 */
  detect(command: string): { hit: true; cmd: string } | { hit: false };
  attachToWs(ws: WsClient, ctx: { enabledFor: (ws: WsClient) => boolean; logHit: (...) => void }): void;
};
```

### 触发动作(两正则**同时**命中)

1. 落 `onsite_discipline_log(kind='write_protection', problem_id, cmd, stdout_preview=前 200 字, at)`
2. emit `'discipline:write-protection-detected'`
3. 修改 assistant 消息 envelope,加 `discipline: { writeOriginalLog: true, cmd }` flag
4. **不**调 StateMachine.apply

### Tests(≥ 8 个)

```ts
test('detect("rm foo.log") 命中', ...);
test('detect("echo x > foo.log") 命中(> 写动作)', ...);
test('detect("sed -i s/x/y/ foo.log") 命中', ...);
test('detect("tee foo.log < /dev/null") 命中', ...);
test('detect("cat foo.log") 不命中(只读)', ...);
test('detect("echo x > notes.md") 不命中(非原日志路径)', ...);
test('detect("ls -la") 不命中(无写动作)', ...);
test('命中落 discipline_log(kind=write_protection)', ...);
test('命中不调 StateMachine.apply', ...);
test('chat 路径 enabledFor=false 不挂载', ...);
test('stdout_preview 截前 200 字', ...);
```

### Commit
`feat(onsite): write-protection middleware`

---

## 通用要求

- 所有中间件统一 `attachToWs(ws, ctx)` 模式,ctx 至少含 `enabledFor` + `logHit`
- 中间件**纯函数**部分(`findWords` / `containsSoftening` / `detect`)可独立测试
- 测试用 `node:test` + `node:assert/strict`
- 不动 Batch 0~3 代码(除非接线需要 import 调整)
- 不动 progress.md / baseline / CI workflows

## 完成后必跑

```bash
# 全量 server 测试(预期 +35 测试,158 → ~193 pass / 2 fail pre-existing)
cd /Users/xylink/ai/xy-claudecodeui && \
node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
  "server/**/*.test.{ts,js}" "server/*.test.{ts,js}"

# chat 路径零回归(157/1 baseline 保留)
bash scripts/regression-chat.sh
```

## 报告格式

写到 `.superpowers/sdd/sdd-workspace/task-4-report.md`(同前 batch 格式)。

## Hard rules

- TDD:每子任务先写测试再写代码,RED → GREEN → REFACTOR
- 不带 Co-Authored-By
- 中文 commit message
- 不修改 chat 路径行为(只挂载 `enabledFor=true` 的 ws)
- 不动 Batch 0~3(接线除外)

## 卡住时

- 若 `ws.kind === 'onsite'` 信息不可得 → 在 `OnsiteWebSocketService.attach` 里设置 `ws.kind = 'onsite'` 后再 attach middleware
- 若 `chat-websocket.service.ts` 不可侵入 → 在 `OnsiteWebSocketService` 里独立走一份,不完全复用 chat 处理逻辑,但共享底层 `wss` 实例
- 若 traceId 来源不明确 → 简单实现:从 `process.env.TRACE_ID` 或 `.traceId` cwd 下文件读出
- 6 子任务过多 → 优先级:4.1 > 4.2 > 4.4.a > 4.5 > 4.3 > 4.4.b(若时间紧可分批 dispatch)

Return when complete。Final response 给 3 句:status, commit count, top concern。