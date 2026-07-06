# Capability: onsite.issue.chat

> **Type**: ADDED
> **Source**: proposal §「分析对话流」

## Purpose

在打开的问题上,复用现有 `claude-sdk.js` 驱动 Claude,Claude 的 `cwd` 强制绑定到问题目录;UI 渲染与主应用 Chat 风格一致,但强制只接 Claude、提供纪律可视化。

## Requirements

### REQ-4.1 cwd 强绑定

The system MUST set `cwd` to `~/work/customer-onsite-analysis/<YYYYMMDD-客户>/` for any Claude spawn triggered from the onsite analysis workspace. The system MUST reject any spawn whose `cwd` falls outside the onsite root.

#### Scenario: 打开问题后,Claude cwd 正确

- **GIVEN** 用户打开 `20260703-山西公安`,Claude session 启动
- **WHEN** 服务端调用 `queryClaudeSDK({ command, options: { cwd: "<问题目录绝对路径>" } })`
- **THEN** Claude 子进程的 `process.cwd()` 为该问题目录
- **AND** UI 顶栏 cwd 锁定显示框显示 `🔒 ~/work/customer-onsite-analysis/20260703-山西公安`

#### Scenario: 拒绝越界 cwd

- **GIVEN** 服务端尝试 `queryClaudeSDK({ options: { cwd: "/etc" } })`
- **WHEN** spawn
- **THEN** 服务端抛 `403 Forbidden`,错误信息 `cwd must be under ~/work/customer-onsite-analysis/`

### REQ-4.2 切换/新建问题后 cwd 重定

The system MUST re-bind `cwd` to the newly selected problem whenever the user switches to a different problem in the sidebar. Any in-flight Claude query for the previous problem MUST be aborted via `abortClaudeSDKSession` before the new query starts.

#### Scenario: 切换问题,前一会话被中止

- **GIVEN** 用户在问题 A 上有一条正在跑的长任务
- **WHEN** 用户点击问题 B
- **THEN** A 的 query 收到 `AbortController` 信号,子进程在 3 秒内退出
- **AND** UI 顶栏 cwd 立刻显示问题 B 的路径
- **AND** A 的会话列表保留为「已中止」状态(下次切回可恢复)

### REQ-4.3 Provider 锁定为 Claude

The system MUST hard-code `provider = 'claude'` in the onsite chat spawn function. The provider selector in the main nav MUST be hidden or disabled while the user is on any `/onsite/*` route. Sessions list for onsite problems MUST NOT include any non-claude providers.

#### Scenario: 路由下 provider 选择器不可见

- **GIVEN** 用户访问 `/onsite/problems/20260703-山西公安`
- **WHEN** 渲染
- **THEN** 顶部 provider 选择器为 `display: none` 或 `disabled`
- **AND** 主应用 Chat 路由 `/chat` 仍可切换 provider(不受 onsite 锁定影响)

### REQ-4.4 对齐与卡片渲染

The system MUST render the chat stream as follows:

- 用户消息:右对齐,蓝色 `hsl(221 83% 53%)` 背景气泡,白字;头像在右
- AI 消息:左对齐,无气泡平铺;Claude 头像在左,使用 `hsl(14 55% 55%)` 品牌橙
- 卡片类型识别(基于 Claude 输出的结构化标签 `<card type="...">...</card>`):
  - `evidence` — 🔍 证据检索,中性灰
  - `blocked` — ⛔ 阻塞清单,琥珀
  - `root_cause` — ✅ 已证实根因,绿
  - `sql` — 📋 待执行 SQL,蓝

#### Scenario: 用户/AI 消息按规范渲染

- **GIVEN** 客户端收到 `[{ role: user, content: "..." }, { role: assistant, content: "..." }]`
- **WHEN** 渲染
- **THEN** 用户消息显示为右对齐蓝色气泡
- **AND** AI 消息显示为左对齐平铺,无背景色
- **AND** 头像位置与方向符合上述规范

#### Scenario: 卡片类型识别正确

- **GIVEN** Claude 输出包含 `<card type="evidence">...</card>`
- **WHEN** 解析
- **THEN** 渲染为🔍图标 + 中性灰标题的证据卡片
- **AND** 类型为 `blocked` 的卡片渲染为琥珀背景 + ⛔ 图标
- **AND** 类型为 `root_cause` 的卡片渲染为绿色背景 + ✅ 图标
- **AND** 类型为 `sql` 的卡片渲染为蓝色背景 + 📋 图标,SQL 关键字高亮

### REQ-4.5 消息头像(用户 / AI 各一)

The system MUST render an avatar element on every chat-stream message:
- 用户消息:30×30px 圆角方块,次级背景色,字「我」居中,位于消息**右**侧(`flex-direction: row-reverse`)
- AI 消息:30×30px 圆角方块,Claude 品牌橙 (`hsl(14 55% 55%)`) 背景,字「C」白色,位于消息**左**侧

The avatar MUST NOT be optional — even when a message has no body content (e.g. an empty assistant frame), the avatar MUST still render to keep the layout stable.

#### Scenario: 用户消息头像在右

- **GIVEN** 客户端收到 `{ role: user, content: "..." }` 帧
- **WHEN** 渲染
- **THEN** 消息 DOM 含 `<div class="avatar user">我</div>`(30×30,右对齐)
- **AND** 气泡在头像左侧,`border-top-right-radius: 4px`(角部削平)

#### Scenario: AI 消息头像在左

- **GIVEN** 客户端收到 `{ role: assistant, content: "..." }` 帧
- **WHEN** 渲染
- **THEN** 消息 DOM 含 `<div class="avatar ai">C</div>`(30×30,橙色,左对齐)

### REQ-4.6 消息角色标签(msg-role 行)

The system MUST render a `msg-role` line directly above each message body:
- 用户消息:文字「现场反馈」(`text-align: right`,灰色 12px)
- AI 消息:文字「Claude · 取证顺序：日志 → 源码 → DB」(灰色 12px,左对齐);后端若能推断当前取证阶段(日志/源码/DB),MUST 替换"取证顺序"段的对应阶段;若无法推断则显示「Claude」

#### Scenario: 用户消息显示「现场反馈」

- **GIVEN** 用户消息 `role = "user"`
- **WHEN** 渲染
- **THEN** 消息体上方显示 msg-role 行,文字「现场反馈」
- **AND** 文字 `text-align: right`

#### Scenario: AI 消息显示取证顺序

- **GIVEN** AI 消息 `role = "assistant"`,且 Claude system prompt 报告当前阶段 = 「源码」
- **WHEN** 渲染
- **THEN** msg-role 行显示「Claude · 取证顺序：日志 → 源码 → DB」,「源码」段加粗或变色

### REQ-4.7 Composer 底部 hint 行(cwd 锁定提示)

The system MUST render a hint line directly below the composer (textarea + buttons), at the bottom edge of the chat stream. The hint MUST contain:
1. 「仅对接 Claude Code」
2. 「工作目录锁定在 <cwd 完整绝对路径>」

The hint MUST be `text-align: center`, 11px, muted color. It MUST be updated whenever the active problem's cwd changes (problem switch).

#### Scenario: composer 底部 hint 显示完整 cwd

- **GIVEN** 用户打开问题 `20260703-山西公安`,cwd = `/Users/xylink/work/customer-onsite-analysis/20260703-山西公安`
- **WHEN** chat 流渲染
- **THEN** composer 下方 hint 行显示「仅对接 Claude Code · 工作目录锁定在 /Users/xylink/work/customer-onsite-analysis/20260703-山西公安」
- **AND** 切换到另一问题后,hint 行的 cwd 路径同步更新

### REQ-4.8 Composer placeholder 工作流化文案

The system MUST set the composer textarea `placeholder` to the exact text 「补充信息、粘贴日志片段，或让 Claude 继续下一步取证…」. The system MUST NOT display keyboard-shortcut instructions (e.g. 「Enter 发送 / Shift+Enter 换行」) inside the placeholder; shortcut hints, if shown, MUST go into a separate `title` tooltip on the send button.

#### Scenario: placeholder 显示工作流化文案

- **GIVEN** chat 流打开,composer 渲染
- **WHEN** 用户未输入任何文字
- **THEN** textarea 显示 placeholder「补充信息、粘贴日志片段，或让 Claude 继续下一步取证…」
- **AND** placeholder 中不含「Enter」「Shift」等键名

### REQ-4.9 空对话流不显示技术化文案

When the messages array is empty (no user or assistant frame yet), the system MUST render the chat-stream scroll area as blank (`background: transparent` or `display: none`). The system MUST NOT display centered text like "No messages yet" / "暂无消息" / "等你说点什么…".

#### Scenario: 刚打开问题,messages 为空

- **GIVEN** 用户刚点开一个新问题,messages 数组为 `[]`
- **WHEN** chat 流渲染
- **THEN** 滚动区域内无任何文字/图标
- **AND** 滚动区域背景透明(显示主区背景色)

### REQ-4.10 证据卡片 logquote 三色高亮(hl / err / ok)

The system MUST apply three distinct inline color styles to substrings inside `<card type="evidence">` bodies:
- `hl`: 琥珀色加粗 — 命中关键字 / 关键阶段标识(例如 `# 已穷尽候选目录,全部 count=0`)
- `err`: 红色 — 命中 0 / 错误片段(例如 grep 输出行末的 `0`)
- `ok`: 绿色 — 成功 / 命中计数非 0 的行

The system MUST detect these patterns from the AI's emitted body text — exact regex set lives in `EvidenceCard.tsx` and MUST be tested by `OnsiteChatStream.test.tsx` with at least one body sample per color.

#### Scenario: 证据卡片显示三色高亮

- **GIVEN** Claude 输出 `<card type="evidence">grep -rc "a1b2" pod-1/\npod-1/foo.log: 0\n# 已穷尽\n</card>`
- **WHEN** 渲染 EvidenceCard
- **THEN** `0` 标红(err)
- **AND** `# 已穷尽` 标琥珀加粗(hl)
- **AND** 其它行文字默认色

#### Scenario: 证据卡片有 OK 行标绿

- **GIVEN** Claude 输出包含 `pod-2/bar.log: 5`
- **WHEN** 渲染
- **THEN** 该行的 `5` 部分标绿(ok)
