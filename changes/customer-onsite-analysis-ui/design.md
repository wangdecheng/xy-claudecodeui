# design: customer-onsite-analysis-ui

> 对应 `proposal.md` + `specs/`,解释**架构决策与取舍**,而非逐行实现。

## 1. 关键集成点(三个被验证的事实)

下面三条决策的依据是**已读源代码**,不是推测:

### 1.1 Claude SDK 已支持 `cwd` 覆盖,**不需改 SDK**

`server/claude-sdk.js:154,167-168`:
```js
function mapCliOptionsToSDK(options = {}) {
  const { sessionId, cwd, toolsSettings, permissionMode } = options;
  ...
  if (cwd) { sdkOptions.cwd = cwd; }
}
```

`queryClaudeSDK(command, options, ws)` 直接接受 `options.cwd`,传给 `@anthropic-ai/claude-agent-sdk` 的 `query()`(→ 子进程 `process.cwd()`)。onsite 路由只需在调用时传 `cwd: <问题绝对路径>`,**完全不动** `claude-sdk.js`。这印证了 proposal 的 "不改 SDK" 取舍。

### 1.2 现有 chat WebSocket 用 `appSessionId` 维度,**可复用**

`server/modules/websocket/services/chat-websocket.service.ts:18-22`:
```ts
type ProviderSpawnFn = (
  command: string,
  options: AnyRecord,  // ← 这里的 options 已含 cwd
  writer: unknown
) => Promise<unknown>;
```

`chat-run-registry` 也是按 `appSessionId` 跟踪 run。onsite 打开一个问题时,在 `sessionsDb` 里建一行 `appSession`(沿用现有 session 创建路径),`cwd` 字段塞进 spawn options。**新 WebSocket 通道不必**。

### 1.3 现有 chokidar session 同步可参考,**但要自己写 problem watcher**

`server/modules/providers/index.ts` 的 `initializeSessionsWatcher()` 是为 chat session 的 `~/.claude` 而写的,onsite 关心的是 `~/work/customer-onsite-analysis/`——**需要新建**一个 `onsiteWatcher`,不复用。

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                         xy-claudecodeui (本仓库)                  │
├─────────────────────────────────────────────────────────────────┤
│ Frontend (React)                                                  │
│ ┌──────────────┐  ┌──────────────────────────────────────────┐ │
│ │ IssueList    │  │ OnsiteChatStream                          │ │
│ │ Sidebar      │  │  ┌────────────────────────────────────┐  │ │
│ │ (新)         │  │  │ User msg (右蓝气泡) / AI msg (左)   │  │ │
│ └──────┬───────┘  │  │ Card: evidence/blocked/root/sql     │  │ │
│        │          │  └────────────────────────────────────┘  │ │
│        ▼          │ StatusBadge · cwdLockView · SofteningTag   │ │
│ ┌──────────────┐  └─────────────┬────────────────────────────┘ │
│ │ onsiteStore  │                │  (zustand)                    │
│ │ (zustand)    │                │                                │
│ └──────┬───────┘                │                                │
│        │ REST + WS              │                                │
├────────┼────────────────────────┼────────────────────────────────┤
│ Server │ (Express + ws)         │                                │
│        │                         ▼                                │
│ ┌──────▼───────────────────────────────┐  ┌──────────────────┐  │
│ │ server/modules/onsite-analysis/       │  │ Claude Agent SDK │  │
│ │  ┌──────────────────────────────┐    │  │ query({          │  │
│ │  │ problem.service (DB+FS)      │    │  │   cwd, prompt,   │  │
│ │  │ config.service (JSON+watch)  │    │  │   options        │  │
│ │  │ log-unpack.service (zip)     │    │  │ })              │  │
│ │  │ state-machine.service        │    │  └────────┬─────────┘  │
│ │  │ discipline-trace-id.middleware│    │           │ spawn      │
│ │  │ discipline-softening.middleware│   │  ┌────────▼─────────┐  │
│ │  └──────────────────────────────┘    │  │ 本机 claude CLI   │  │
│ │              │                       │  │ (cwd=问题目录)    │  │
│              │ REST  /api/onsite/*     │  └──────────────────┘  │
│              │ WS    /onsite/ws (复用) │                         │
├──────────────┼────────────────────────┼─────────────────────────┤
│ 持久化       │                       │                         │
│  ┌───────────▼────┐  ┌──────────────┐ │                         │
│  │ ~/.cloudcli/   │  │ problem.json │ │                         │
│  │ auth.db        │  │ (per 问题)   │ │                         │
│  │ + onsite_* 表  │  └──────────────┘ │                         │
│  └────────────────┘                  │                         │
│  ~/work/customer-onsite-analysis/     │                         │
│   └── 20260703-山西公安/                │  ← cwd 锁定             │
│        ├── problem.json               │                         │
│        ├── unpacked-1/                │                         │
│        ├── unpacked-2/                │                         │
│        └── analysis/  ← Claude 写产出 │                         │
└─────────────────────────────────────────────────────────────────┘
```

## 3. 关键架构决策

### D-1:onsite session 与 chat session 共用 `sessionsDb` 表

| 选项 | 取舍 |
|---|---|
| A. 新表 `onsite_sessions` | 隔离清晰,但要双写/abort/历史都重写一遍 |
| B. **共用 `sessionsDb`,加 `kind` 字段('chat' / 'onsite')** ✅ | 沿用 `chatRunRegistry` / `chatSessionWriter` / abort 流程;只过滤时多一个 `WHERE kind = 'onsite'` |
| C. 完全独立服务 | 违背"复用现有工程"约束 |

**决策:B**。`sessions` 表加 `kind TEXT NOT NULL DEFAULT 'chat'`,onsite 创建时 `kind = 'onsite'`。所有现有 `chat_*` 服务在 `kind` 过滤后直接复用,不动 chat 路径。

**代价**:需要给 sessions 表做一次 `migrations` 增量;`chat-run-registry` 的 abort/listing 路径需在 `kind` 维度补查询条件,改动面小且无破坏性。

### D-2:onsite chat 复用现有 `chat-websocket.service.ts`,**不新开通道**

`server/modules/websocket/services/chat-websocket.service.ts` 已经把 `ProviderSpawnFn` 抽象成 `(command, options, writer) => unknown`,onsite 在 spawn options 里塞 `cwd`,语义零差异。

`spawnFns` 注入点(`server/index.js` 的 `wss` 构造)已经是依赖注入,onsite 路径在 `wss` 上注册同样的回调——**新增不修改**。onsite chat 的所有消息体格式(`user/assistant/tool_use/permission_request` 等)与 chat 完全相同,只是消息 envelope 里多个 `kind: 'onsite'`,供前端按 router 决定渲染哪种流。

**决策:零新通道**。`/onsite/ws` 实际就是同一个 `wss`,客户端连上后第一帧声明 `kind: 'onsite'`,服务端做 `kind` 维度过滤/审计。

### D-3:`problem.json` 与 `onsite_problems` 表双写,谁是真源?

| 数据 | 真源 | 理由 |
|---|---|---|
| 客户/迭代/数据库/状态/创建时间/分支 | **文件系统 `problem.json`** | 终端 agent 直接可读;人 mv/cp 目录时数据跟着走 |
| `user_id`(归属)、`updated_at`(精确时间)、`mtime` 缓存 | **`onsite_problems` 表** | 关系型字段,便于 JOIN/列表/排序 |
| 已上传文件清单 | **`onsite_files` 表** | 关联查询(按问题聚合、按用户聚合) |
| 状态变更审计 | **`onsite_state_audit` 表** | append-only,需要时序索引 |
| 软化词命中 | **`onsite_discipline_log` 表** | 同上,审计用 |

**决策**:新建/修改问题时先写 `problem.json`,再写 `onsite_problems`,**`problem.json` 是权威**。表里冗余存一份是为列表/排序/审计的查询效率;若发现不一致(磁盘 vs DB),**以磁盘为准**并把表更新回去。

**失败处理**:表写入失败不阻塞(返回 `201`,仅 stdout warn);磁盘写入失败必须 `500`(目录都不存在,UI 也跑不了)。

### D-4:配置文件改用**后端读 + API 暴露**,而非前端直接 fetch

| 选项 | 取舍 |
|---|---|
| A. 前端 fetch `config/customer-analysis.json` | 部署到子路径会 404;`file://` 协议 Chrome 拦截;无热加载感知 |
| B. **后端读 + `GET /api/onsite/config`** ✅ | 部署灵活;后端统一处理 mtime 监听;前端只关心 API |
| C. 编译期 import JSON | 无法运行时改,违反 REQ-6.1 热加载 |

**决策:B**。`config.service` 持单例,启动时一次加载,`fs.watch` 监听 mtime 变化触发重读;`/api/onsite/config` 直接返回单例(并附 `mtime` 供前端做"刚才是这份配置"标识)。

### D-5:状态机实现为 service,而不是 enum + 散落 if

把 7 条合法迁移(`pending_info → analyzing` 等)集中到 `state-machine.service.ts` 的纯函数 `canTransition(from, to): { ok: true } | { ok: false, allowed: [...] }`,所有 `PATCH` 路由先调这个函数,再写库。

**决策**:独立 service,纯函数 + 表驱动。新增状态时改一个表就行;UT 一行一个 case。

### D-6:纪律中间件挂载在 chat 消息流,而非新建分支

软化词扫描与 traceId-0 监测都在 **Claude 消息出口** 做(REACT 子进程吐出的 `assistant` / `tool_result` 消息)。具体:

- **traceId 监测**:在 `chat-websocket.service.ts` 的消息分发前,新增一个 `disciplineTraceIdMiddleware`。它**不修改**原消息流,只是旁路 emit 一个 `discipline:trace-id-empty` 事件给 `state-machine.service`,触发 `PATCH blocked`。
- **软化词扫描**:同样旁路 emit `discipline:softening-detected`,落 `onsite_discipline_log` 表;同时**修改**原消息(`<softening>` 标签注入),再发到客户端。

中间件放在 chat-websocket 的消息出口(对所有 onsite 消息生效),但通过 `enabledFor(ws)` 检查 `ws.kind === 'onsite'`——这样 chat 路径行为完全不变。

**决策:中间件独立、可插拔**。不在 `claude-sdk.js` 里写纪律代码(避免污染 chat 路径),而是在 WebSocket 出口层挂载。

### D-7:Claude 写文件路径黑名单 + write-protection 中间件(双层防护,防 C-2)

**问题**:REQ-4.1 的 cwd 锁定是**单层**防线——Claude 仍能写 `cwd` 下的任意文件。`customer-onsite-analysis/CLAUDE.md` 说"日志原文不要删改",但 SDK 层无法硬强制。仅靠 `disallowedTools` 字符串匹配也不够——Claude 可以 `> foo.log` 重定向、`sed -i` 原地改、Python `open(...)` 写回、`tee foo.log < /dev/null`、MCP 工具或 `curl` 上传修改后的日志。

**决策**:**双层防护**——SDK 层硬拦截 + 运行时软审计,完全不动 `claude-sdk.js`。

#### 7.1 路径黑名单(disallowedTools 注入)— SDK 硬拦截

`OnsiteWebSocketService` 在 spawn Claude 前,调 `onsite-path-blacklist.service.ts` 把 glob 转成 SDK 的 `disallowedTools` 模式,追加到 `options.disallowedTools`。现有 `canUseTool`(`server/claude-sdk.js:589-594`)的 `isDisallowed` 分支已经处理:`return { behavior: 'deny', message: 'Tool disallowed by settings' }`,**直接复用,零 SDK 改动**。

**扩展 glob 覆盖**(从原 `*.log / *.log.gz / *.jsonl / unpacked-*` 扩到 6 类):

| 原始 glob | 生成的 `disallowedTools` pattern |
|---|---|
| `*.log` | `Bash(rm **/*.log)`, `Bash(> **/*.log)`, `Bash(tee **/*.log)`, `Bash(sed -i **/*.log)`, `Bash(python*open*.log)`, `Bash(python*>*.log)`, `Write(**/*.log)`, `Edit(**/*.log)` |
| `*.log.gz` | 同上(全部 `*.log` 替换 `*.log.gz`) |
| `*.jsonl` | 同上(全部 `*.log` 替换 `*.jsonl`) |
| `unpacked-*` | `Bash(rm **/unpacked-*)`, `Bash(rm -rf **/unpacked-*)`, `Bash(> **/unpacked-*/**)`, `Write(**/unpacked-*/**)`, `Edit(**/unpacked-*/**)` |
| `problem.json` | `Write(**/problem.json)`, `Edit(**/problem.json)`(Claude 不能改元数据) |
| `*.tar.gz` / `*.tgz` | `Bash(rm **/*.tar.gz)`, `Write(**/*.tar.gz)`(已上传的压缩包不可改) |

**chat 路径不调**这个 service,`disallowedTools` 不被注入;现有 chat 行为完全不变。

#### 7.2 write-protection 中间件 — 运行时软审计

仅靠 `disallowedTools` 字符串匹配仍可能漏(Claude 用 MCP 工具 / `curl` / `awk` 改写 / Python 子进程组合)。**新增 `discipline-write-protection` 中间件**(挂载在 chat 消息出口,与 `discipline-softening` / `discipline-trace-id` 并列):

- 监听 `tool_result`,**改写** Claude 原始 message body,匹配 `command` 字段中"写动作 + 原始日志路径"模式
- 命中模式:
  - 写动作:`rm | > | tee | sed -i | awk -i | python .* open\(.* ['\"]w` 等
  - 原始路径:`*.log | *.log.gz | *.jsonl | problem.json | unpacked-* | *.tar.gz`
- 命中动作:
  - 落 `onsite_discipline_log(kind='write_protection', problem_id, cmd, stdout_preview, at)`
  - 在 assistant 消息 envelope 加 `discipline: { writeOriginalLog: true, cmd: '...' }` flag
  - **不**自动 blocked(让 Claude 完成当前工作),**不**改原消息内容(只审计)
  - UI 按 flag 弹琥珀 toast"⚠️ Claude 尝试写原始日志,详见审计"
- Claude system prompt 在 `onsite-websocket.service.ts` 启动时注入"原始日志禁改"规则(放在所有 prompt 之前),作为软约束
- chat 路径(`enabledFor(ws) === false`)不挂载,行为不变

**为什么这样安全**:
- `disallowedTools` 是"硬拦截"(Claude 试图 `rm foo.log` → SDK 直接拒,无法绕开)
- write-protection 是"软审计"(MCP / `curl` / 复杂管道走通了,事后我们看到)
- 两层互补:硬层覆盖 90% 写动作,软层补剩下的边界
- 即使软层全失效,硬层至少保证"Claude 不能 rm / 改写 problem.json",最坏情况是"Claude 读 + 改 + 上传新文件",不破坏原始日志

**任务**:tasks §5.1 扩展 `ONSITE_PROTECTED_GLOBS` + `toDisallowPatterns`;tasks §4.5 新建 `discipline-write-protection` 中间件

#### 7.3 现有 REQ-4.1 防护链总结

| 防线 | 阻挡 | 触发点 |
|---|---|---|
| cwd 锁定(REQ-4.1) | Claude 跑出 `~/work/customer-onsite-analysis/<dir>/` | spawn 时 `cwd` 注入 |
| 硬层:disallowedTools(7.1) | Claude `rm/Write/Edit/> /tee/sed -i/python` 原始日志 | SDK `canUseTool` 拒绝 |
| 软层:write-protection(7.2) | Claude 走 MCP / `curl` / `awk` 写原始日志 | 运行时审计 + 琥珀 toast |
| 路径黑名单 + write 防护 | Claude 改 `problem.json` 元数据 | 7.1 glob 含 `problem.json` |

任何单层失效不影响其他层。

为什么安全(7.1):
- 现有 `mapCliOptionsToSDK` 第 208 行 `sdkOptions.disallowedTools = settings.disallowedTools || []` 已把 disallowedTools 透传,不需要新增字段
- 现有 chat 测试不需要改;新增的测试只覆盖"onsite 路径注入成功"+"chat 路径不注入"
- 风险上限:Claude 写文件被拒——**不会**改 chat 任何工具调用行为

### D-8:UI 不允许手动输入的强制方案

REQ-1.2/6.3 的"零硬编码 + 不允许手动输入"是 hard 约束。光靠组件代码遵守不够,需要**两道防线**:

1. **代码层**:`<select>` 是 React 组件,`<option>` 从 `config-service` 拉;**不**渲染任何 `<input type="text">` / `<datalist>` / `autoComplete`。
2. **CI 静态扫描**:`scripts/validate-no-hardcoded-customers.sh` 在 PR 流水线跑,grep 命中即 fail:
   - `src/components/onsite-analysis/**` 含「手动输入」/「其他」/「请输入客户」/「请输入迭代」/ 字面量
   - `src/components/onsite-analysis/**` 含已知客户名(白名单排除原型文件)

第二道防线是**保险**——万一有 PR 漏掉了,我们 CI 抓住。

### D-9:traceId 检测从「单一命令匹配」升级为「多信号融合」(防 C-1)

**问题**:原 §4.2 / §4.4 设计的"正则匹配 `grep ... '<traceId>'` + stdout 全 0 → blocked"启发式太脆弱。Claude 实际可能用 `rg` / `ag` / `ack` / `find -exec grep` / `bash -c` / `cat \| grep` / `mcp__filesystem__read_file` 后在内存里匹配,或跑 10+ 个 grep(不是每个 0 命中都是 traceId 问题)。简单命令前缀匹配会有大量漏报与误报。

**决策**:把检测点从"工具命令前缀匹配"挪到"多信号融合",主信号是 AI 总结语,工具命令降级为辅助。

| 信号来源 | 权重 | 触发动作 |
|---|---|---|
| **AI `assistant` 文本含**"未找到 / 0 结果 / no matches / found nothing / 无命中 / 没有结果" | **主信号** | emit `discipline:trace-id-empty` → 调 `StateMachine.apply('blocked')` |
| 工具命令匹配 `grep\|rg\|ag\|ack ... <traceId>` + stdout 全 0 | 强信号 | emit `discipline:trace-id-empty` |
| 工具命令形如 `find ... -exec grep` / `cat ... \| grep` / `bash -c "...grep..."` + 0 命中 | 弱信号 | emit `discipline:trace-id-suspect`(**不**自动 blocked) |
| 其他任意 0 命中(无明显 grep 语义) | 弱信号 | emit suspect |

**机制**:
1. **主信号**(AI 文本扫描):在 `chat-websocket.service.ts` 的 assistant 消息出口,用正则 `/未找到|0\s*结果|no matches|found nothing|无命中|没有结果/i` 扫描 message body;命中 → 旁路 emit `discipline:trace-id-empty`
2. **强信号**(工具命令):保留原 §4.4 逻辑,但 glob 扩到 `grep|rg|ag|ack`
3. **弱信号**(suspect):落 `onsite_discipline_log` + UI 琥珀 toast 提示,不调 StateMachine
4. **client-side flag**:在 assistant 消息 envelope 里加 `discipline: { traceIdEmpty: boolean, softeningWords: string[] }`,前端按这个渲染徽章(不再依赖 XML 标签猜)

**为什么这样安全**:
- 主信号精度高(Claude 自己用自然语言说"没找到",误报率低)
- 强信号保留作为 backup(原 §4.4 仍工作)
- 弱信号降级,避免"Claude 跑了 10 个 grep 都被 block"的过度反应
- client-side flag 让前端不需要解析文本就能渲染徽章,更可靠

**任务**:tasks §4.4 拆成 §4.4.a(主信号 + 强信号)+ §4.4.b(弱信号 suspect)

## 4. 关键时序图

### 4.1 新建问题(REQ-1)

```
User        NewIssueWizard   problem.service   config.service   sessionsDb
 │              │                 │                  │              │
 │ open wizard │                 │                  │              │
 ├─────────────▶                 │                  │              │
 │              │ GET /api/onsite/config              │              │
 │              ├─────────────────┼─────────────────▶│              │
 │              │◀───── { customers, iterations, mtime } ───────┤              │
 │ fill 3 fields                  │                  │              │
 │ submit                        │                  │              │
 ├─────────────▶                 │                  │              │
 │              │ POST /api/onsite/problems          │              │
 │              ├─────────────────▶                  │              │
 │              │                 │ mkdir -p 20260703-客户/      │
 │              │                 │ write problem.json            │
 │              │                 │ INSERT onsite_problems        │
 │              │                 ├─────────────────┼─────────────▶│
 │              │◀───── 201 Created { id, cwd } ──────┤              │
 │◀──── toast + redirect ────────▶                  │              │
 │              │                  │ chokidar emits add            │
 │              │◀──── WS problem:added ──────────────────────────┤
```

### 4.2 分析中触发 traceId=0 → blocked(REQ-8)

```
User       OnsiteChat    WS chat-      discipline-       state-        sessionsDb
              Stream     service       traceId mw        machine
                │           │              │               │              │
 │ send msg w/ traceId      │              │               │              │
 ├──────────▶│              │              │               │              │
 │            │ ws.send     │              │               │              │
 │            ├───────────▶│              │               │              │
 │            │            │ spawn claude, cwd locked     │              │
 │            │            │   ...                        │              │
 │            │            │ stream: tool_result          │              │
 │            │            │   "grep rc ... -> 0\n0\n0"  │              │
 │            │            │─────────────▶│               │              │
 │            │            │              │ emit discipline:trace-id-empty
 │            │            │              ├──────────────▶│              │
 │            │            │              │               │ PATCH blocked│
 │            │            │              │               ├─────────────▶│
 │            │            │              │               │ audit row    │
 │            │            │              │               │◀─────────────┤
 │            │            │              │               │ broadcast    │
 │            │◀─── state-changed + insert ⛔ card ───────────────────────┤
```

### 4.3 软化词扫描(REQ-9)

```
Claude  →  WS chat-service  →  discipline-softening mw  →  WS writer  →  client
                  │                       │                    │            │
                  │ assistant msg         │                    │            │
                  ├──────────────────────▶│                    │            │
                  │                       │ match "可能"        │            │
                  │                       │ rewrite msg        │            │
                  │                       │   + <softening/>   │            │
                  │                       │ log discipline     │            │
                  │                       ├───────────────────▶│            │
                  │                       │                   │ forward    │
                  │                       │                   ├───────────▶│
                  │                       │                   │            │ render
                  │                       │                   │            │ 琥珀波浪线
```

## 5. 风险与缓解(与 proposal 对齐 + 补充)

| 风险 | 缓解(已在 D-* 决策中) |
|---|---|
| fallback 内嵌导致配置改了不生效 | D-4 后端读 + 真实实现时删 `CONFIG_FALLBACK`;CI 静态扫描 |
| cwd 越界 | D-1 `queryClaudeSDK` 已支持 cwd;新增 zod 校验 `cwd.startsWith(onsiteRoot)` |
| 现场日志被 Claude 误改 | **D-7** 路径黑名单 + `canUseTool` 拒绝 |
| 多端同时编辑同一问题 | chokidar mtime 监听 + WebSocket `problem:changed` 广播,UI 提示刷新 |
| 状态机写崩 | **D-5** 纯函数 + 表驱动,UT 100% 覆盖 7 条合法边 + 非法边 |
| 中间件污染 chat 路径 | **D-6** `enabledFor(ws) → ws.kind === 'onsite'` 隔离 |

## 6. 不在 design 里的事(留给 tasks.md)

- 任务拆分、批次依赖、文件路径 → `tasks.md`
- 端到端 demo 脚本 → `tasks.md` 验收章节
