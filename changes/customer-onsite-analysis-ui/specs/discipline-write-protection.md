# Capability: onsite.discipline.write_protection

> **Type**: ADDED
> **Source**: proposal §「纪律可视化」+ `design.md §D-7.2`(防 C-2 软层)

## Purpose

`customer-onsite-analysis/CLAUDE.md` 明确"原始日志不要删改"。该能力**双层落地**:(1) 硬层:`disallowedTools` 字符串匹配(详见 `design.md §D-7.1` 与 tasks.md §5.1);(2) 软层:本 spec 描述的 `discipline-write-protection` 运行时审计中间件。软层覆盖硬层抓不到的边界(MCP 工具、`curl` 上传、`awk` 改写、Python 子进程组合等),即使拦不住也留下证据。

## Requirements

### REQ-10.1 中间件挂载与隔离

The system MUST attach a `discipline-write-protection` middleware to all WebSocket connections where `ws.kind === 'onsite'`. The middleware attachment function MUST check `enabledFor(ws) === true` before any detection runs. Chat-path connections (`ws.kind === 'chat'`) MUST NOT have this middleware attached.

#### Scenario: 软层只在 onsite 路径生效

- **GIVEN** 用户在主 chat 页面(`/`)开 session
- **WHEN** Claude 跑 `Bash({ command: "rm foo.log" })`
- **THEN** 主 chat 状态不变、消息流不变、`onsite_discipline_log` 不增行、envelope 无 `discipline.writeOriginalLog` flag
- **AND** `chat-regression-baseline.txt` 前后对比通过

### REQ-10.2 写动作 + 原始路径双正则匹配

The middleware MUST detect the write-protection condition by matching **both** patterns against the `tool_result` message's `command` field:

- **写动作正则**:`/\b(rm|rm\s+-rf|tee|cp\s+-f|mv|cat\s+.*>|sed\s+-i|awk\s+-i|>\s*[^&|])\b/`
- **原始路径正则**:`/(?:^|\s|\/|\\)([^\\\/\s]+\.(log|log\.gz|jsonl|tar\.gz|tgz)|problem\.json|unpacked-[\w-]+)(\s|$|\/|\\)/`

Two patterns MUST both match for the middleware to fire.

#### Scenario: rm foo.log 命中

- **GIVEN** Claude 调用 `Bash({ command: "rm foo.log" })`
- **WHEN** middleware 扫描
- **THEN** 双正则同时命中 → 触发审计

#### Scenario: echo x > foo.log 命中

- **GIVEN** Claude 调用 `Bash({ command: "echo x > foo.log" })`
- **WHEN** middleware 扫描
- **THEN** 写动作正则匹配 `>`,原始路径正则匹配 `foo.log` → 触发

#### Scenario: cat foo.log(只读)不命中

- **GIVEN** Claude 调用 `Bash({ command: "cat foo.log" })`
- **WHEN** middleware 扫描
- **THEN** 写动作正则不匹配(无 `rm/tee/sed -i/> /cp -f/mv`)→ **不**触发

#### Scenario: echo x > notes.md(非原日志路径)不命中

- **GIVEN** Claude 调用 `Bash({ command: "echo x > notes.md" })`
- **WHEN** middleware 扫描
- **THEN** 写动作正则匹配 `>`,但原始路径正则不匹配 `notes.md` → **不**触发

### REQ-10.3 触发动作(落库 + flag + 不 blocked)

When a write-protection attempt is detected, the middleware MUST:
- Insert a row into `onsite_discipline_log` with fields `(kind='write_protection', problem_id, cmd, stdout_preview=前 200 字, at=ISO8601)`
- Augment the original `assistant` message envelope with `discipline: { writeOriginalLog: true, cmd: '<原始命令>' }` flag
- Emit a `discipline:write-protection-detected` event
- **NOT** call `StateMachine.apply`(状态不变,Claude 可继续当前工作)

#### Scenario: 触发后状态不变

- **GIVEN** 问题状态 `analyzing`
- **WHEN** Claude 调用 `Bash({ command: "rm iauth.log" })` 触发软层
- **THEN** 状态**保持** `analyzing`
- **AND** `onsite_discipline_log` 新增 1 行 `kind='write_protection'`
- **AND** 该 Claude 消息的 envelope 含 `discipline: { writeOriginalLog: true, cmd: 'rm iauth.log' }`
- **AND** UI 弹琥珀 toast"⚠️ Claude 尝试写原日志 iauth.log"

### REQ-10.4 system prompt 软约束注入

When `onsite-websocket.service.ts` spawns a Claude subprocess, the system MUST inject the following rule at the **top** of the system prompt (before all other instructions):

```
[HARD RULE - 现场纪律]
禁止修改 cwd 下的 *.log / *.log.gz / *.jsonl / unpacked-* / problem.json / *.tar.gz 等文件。
如需分析,只读不改,产出写到 analysis/ 子目录。
违反此规则将被审计并提示用户。
```

#### Scenario: system prompt 顶部含规则

- **GIVEN** onsite 路由下打开一个问题
- **WHEN** spawn Claude 子进程
- **THEN** 子进程的 stdin 第一段是「HARD RULE - 现场纪律」规则
- **AND** 该规则位置**在**其他所有 prompt 之前(优先级最高)

### REQ-10.5 UI 计数与列表

The client MUST display in the chat head a counter: `本会话写原日志 N 次`, linked to a list view showing each attempt's `cmd` + `at` + `stdout_preview`.

#### Scenario: 计数器与列表渲染

- **GIVEN** 当前问题在一次会话中触发了 3 次软层
- **WHEN** UI 渲染
- **THEN** 头部「本会话写原日志 3 次」计数 = 3
- **AND** 点击计数弹窗显示 3 条明细,每条含 cmd + 时间 + stdout 前 200 字

## 与硬层(disallowedTools)的关系

| 防线 | 阻挡对象 | 触发点 | 失败模式 |
|---|---|---|---|
| **硬层**:disallowedTools 字符串匹配 | Claude `rm/Write/Edit/> /tee/sed -i/python open` 原始日志 | SDK `canUseTool` 直接拒 | 字符串匹配漏(Claude 用 MCP / curl / awk 改写) |
| **软层**(本 spec) | Claude 走 MCP / curl / awk / Python 子进程组合写原始日志 | 运行时审计 + 琥珀 toast | Claude 已写,事后才能看到 |

两层互补。硬层覆盖 90% 写动作,软层补剩下的边界。即使软层全失效,硬层仍保证 Claude 至少不能用 `rm` / `Write` / `Edit` 改原始日志,**最坏情况是 Claude 读 + 改 + 上传新文件**,不破坏原始日志。
