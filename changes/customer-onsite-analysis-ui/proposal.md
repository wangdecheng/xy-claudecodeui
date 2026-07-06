# proposal: customer-onsite-analysis-ui

## Why

`~/work/customer-onsite-analysis/` 已经有成熟的现场排查工作流:`YYYYMMDD-<客户简称>/` 目录 + 三项必给信息(客户 / 迭代 / 数据库) + 严格纪律(证据优先、traceId 必找、一次只问一件、阻塞清单禁推测)。但整套流程目前仅在终端里用 Claude Code CLI 手工跑,可视化与协作成本高(无会话历史视图、日志原文与结论在两个媒介里、状态/分支/待办散落在对话和文件系统中)。

本变更把现有工作流搬到 xy-claudecodeui 的 Web UI 上,沿用同一套 Provider 抽象与 Claude Agent SDK 集成,只新增一个垂直场景:**客户现场问题分析工作台**。

## What Changes

新增一个工作台页面 `Onsite Analysis` 及其配套的运行时模块,核心能力:

- **问题列表侧栏**:扫 `~/work/customer-onsite-analysis/` 下的 `YYYYMMDD-*` 目录,每条显示客户名 + 状态(待补信息 / 分析中 / 已证实 / 阻塞)+ 迭代/数据库 chip + 最后修改时间
- **新建问题向导**:强制收齐三项必给信息(客户 / 迭代 / 数据库),客户与迭代下拉**完全由 `config/customer-analysis.json` 驱动,UI 不允许手动输入**;接受多文件日志上传,服务端按"一包一目录"解压
- **分析对话流**:复用 `claude-sdk.js` 的 query/canUseTool 流,Claude 在该问题目录的 `cwd` 下工作;用户消息右对齐蓝色气泡、AI 消息左对齐平铺;证据/根因/阻塞/SQL 各自以卡片内联
- **状态机**:每个问题有 `pending_info / analyzing / confirmed / blocked` 四态,头部 info-chip 与侧栏徽章同步,手动切换需留下理由
- **可视化纪律内化**:traceId 全目录扫描后命中 0 时强制进阻塞态,绝不输出"可能是 X"句式
- **配置文件**:仓库内置 `config/customer-analysis.json`,**唯一真相源**;`customers[].branch == null` 触发头部"不涉及三方对接"联动(隐藏 third-bridge 分支 chip)
- **新文件类型**:`design-prototypes/customer-onsite-analysis/` 下的 `index.html` 原型已确认设计方向,本次变更把它集成进主应用路由

## Out of Scope

明确**不做**的事,避免 scope creep:

- **不接其他 Provider** —— 顶部 provider 选择器只保留 `Claude Code` 一项;Cursor/Codex/Gemini/OpenCode 的入口保持现状,不显示在 onsite 工作台里
- **不改 Claude Agent SDK 本身** —— 复用现有 `server/claude-sdk.js` 的 `queryClaudeSDK()` / `canUseTool` / `resolveToolApproval`;只在 wrapper 层做"问题→cwd+context"映射
- **不重做会话/文件/Shell/命令面板/MCP 等通用能力** —— 沿用现有 `src/components/`,onsite 只新增"问题列表 + 新建向导 + 对话流(卡片化)"三块
- **不写跨问题的合并视图** —— 一个工作台只服务一个打开着的问题;跨问题分析留给终端
- **不实现后端"自动跑测试/巡检"等主动任务** —— onsite 是被动的人机协作工作台,不是后台 agent
- **不引入新的 DB schema** —— 复用 `~/.cloudcli/auth.db` 里的 sessions / projects 表;问题级元数据(状态、分支、最后修改)由文件系统直接反映(目录 + JSON 元文件 `problem.json`)
- **不修改 `customer-onsite-analysis/CLAUDE.md`** —— 那是给终端 agent 用的工作守则,本次变更只是给同一个工作流多一个 UI 入口;工作流纪律通过 UI 的卡片化(证据/阻塞/SQL 卡片)+ 头部状态徽章呈现,不修改原 CLAUDE.md

## Why Not: 候选方案与拒绝原因

| 候选 | 拒绝原因 |
|---|---|
| **独立 Electron App(全新工程)** | 重复实现 Provider 抽象/SDK 集成/认证/会话管理,违背"复用 xy-claudecodeui"的总约束 |
| **Web 端独立 Next.js / Vite 工程** | 同上,且部署形态割裂(主应用桌面 + 这套 web) |
| **直接在终端里写一个 /onsite slash command** | 不解决"会话历史/状态视图/可视化证据"的核心诉求;且与现有 workflow-start 等 skill 重叠 |
| **改造现有 Chat 页加新 tab** | Chat 抽象的是"项目级 session",onsite 是"问题级 session + 工作流纪律",两种模型强耦合会让 Chat 变复杂 |
| **强制要求现场机必须有 .claude/ai/auth.db** | onsite 是单机使用,应沿用终端/CloudCLI 的 `~/.cloudcli/auth.db` 模式,降低前置成本 |

## Affected Areas

新增/修改的大致范围(在 `xy-claudecodeui` 仓库内):

- **新增路由**:`src/components/onsite-analysis/`(问题列表/对话/向导),在 `src/App.tsx` 注册 `/onsite/*`
- **新增服务端模块**:`server/modules/onsite-analysis/`(扫描目录、读写 `problem.json`、日志解压、配置文件 API)
- **新增配置文件**:`config/customer-analysis.json`(已存在,只读不改)
- **新增数据库**:`.cloudcli/auth.db` 新增表 `onsite_problems` 与 `onsite_files`(放会话/工作流状态/已上传文件元数据)
- **复用不改**:`server/claude-sdk.js`、`server/modules/providers/`、Claude Code Provider、`src/components/chat/` 的核心组件
- **不动**:`server/cursor-cli.js`、`server/gemini-cli.js`、`server/openai-codex.js`、`server/opencode-cli.js`、`electron/`

## Success Criteria

变更完成必须满足的全部条件(可验证):

1. **三项必给信息强制采集**:新建向导必填客户/迭代/数据库三项,缺一禁用提交;任一字段被清空时按钮置灰 + 红字提示
2. **下拉由配置驱动**:客户下拉 13 项(首项「不涉及三方对接」)+ 迭代下拉 2 项,选项与 `config/customer-analysis.json` 一致;源码里**不存在**任何硬编码的客户名/迭代名(grep `customers|iterations` 的字面量应只出现在 `config/customer-analysis.json` 与自动生成的 UI 标签代码中)
3. **不允许手动输入**:客户/迭代字段为裸 `<select>`,无 input 元素、无 typeahead、无"其他"选项;提交校验中包含"必须从下拉选择"这一条
4. **工作目录锁定**:选中问题后,Claude 的 `cwd` 必须是 `~/work/customer-onsite-analysis/<YYYYMMDD-客户>`,且任意时刻切换/新建问题后 `cwd` 都自动重定;UI 顶部永久显示当前 cwd(带锁图标,只读)
5. **Provider 锁定**:onsite 路由下 provider 切换器仅显示 `Claude Code` 一项,不可切换;会话列表只显示 onsite 类型会话
6. **纪律可视化**:Claude 输出"可能是/也许是/似乎"等软化词时,前端高亮警告 + 后端审计日志记录;输出"已证实/未证实"标签强制存在
7. **traceId 0 命中 → 阻塞态**:Claude 跑 `grep` 后若所有候选目录 count=0,自动把问题状态切到 `blocked`,UI 头徽章变琥珀、阻塞清单卡片置顶
8. **一包一目录**:上传多个 zip 时服务端并行解压到 `pod-1/` `pod-2/` …,**禁止**解压到同一目录;后端单元测试覆盖此规则
9. **配置热加载**:修改 `config/customer-analysis.json` 后,前端下拉 1 秒内反映(无需重启服务);后端 watchdog 检测文件 mtime 变化
10. **零硬编码客户/迭代**:`grep -rn "sinopec\|zgj_565939\|psbc_youchu" src/ server/ design-prototypes/onsite-analysis/` 命中数 ≤ 5(只允许出现在测试数据、CLAUDE.md 引用、文档示例中)
11. **纪律护栏与回归门禁**(`design.md §D-7.1/7.2` + `§D-9` + `tasks.md §0.1/§0.2/§5.5`):
    - **traceId 多信号检测**:主信号(AI 文本扫描 `未找到/0 结果/no matches/...`)+ 强信号(`grep/rg/ag/ack ... <traceId> + 0`)+ 弱信号(suspect,非自动 blocked)三层融合;`discipline-trace-id` middleware 必须挂载到所有 `kind='onsite'` WebSocket
    - **写原日志双层防护**:`disallowedTools` 硬层覆盖 7 类 glob × 7 种写动作(`rm/>/tee/sed -i/python open/Write/Edit`);`discipline-write-protection` 软层覆盖 MCP/curl/awk 兜底;`on Claude spawn` 注入「HARD RULE - 现场纪律」规则置顶
    - **chat 路径零回归**:Batch 0 在变更前建立 `chat-regression-baseline.txt`,Batch 5 末尾用 `scripts/regression-chat.sh` + `scripts/diff-chat-impact.sh` 强制对比 baseline;`chat-websocket.service.ts` / `claude-sdk.js` 在 PR diff 中**不允许**有非预期改动(由 `diff-chat-impact.sh` 拦截)
    - **migrations 原子性**:`db.transaction(() => {...})()` 包裹整个迁移;启动时 `verifyMigrations(db)` 校验 sha,失败 `process.exit(1)`;第 3 张表创建失败时前 2 张也回滚

## Risks & Mitigations

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| **fallback 内嵌导致配置改了不生效** | 中 | 高 | 上线前删除 `CONFIG_FALLBACK` 块;并在 guard check 中加入"客户端必须无任何 customers/iterations 字面量"的静态扫描 |
| **现场机有多个 Claude Code 认证账号时 cwd 错乱** | 中 | 中 | 显式持久化"问题→cwd 映射"在 auth.db 的 `onsite_problems.cwd` 字段;SDK spawn 强校验 cwd 存在 |
| **配置文件误改破坏全部用户** | 中 | 高 | 加 JSON schema 校验;首项必须是 "不涉及三方对接";branch 字段重复检测 |
| **多端同时编辑同一问题目录** | 中 | 中 | 切换/打开问题前刷新 mtime;提示"目录已被其他端修改,请刷新" |
| **Claude 直接修改文件破坏现场日志** | 低 | 高 | cwd 锁在 `~/work/customer-onsite-analysis/<dir>/`,Claude 写文件可走 `<dir>/analysis/` 子目录;禁止写 `<dir>/*.log` 等原始日志路径(后端做路径黑名单) |
| **Web 端暴露现场隐私** | 中 | 高 | 沿用 xy-claudecodeui 现有 auth(JWT + bcrypt);默认仅本机 `127.0.0.1` 监听,与主应用一致 |

## Non-Goals(后续可能做,本次不做)

- 跨问题关联分析(同一客户的多个问题聚合)
- 主动周期巡检
- 移动端原生 App(主应用已有移动端响应式,onsite 复用即可)
- 把"现场"扩展到"研发内部 bug 排查"(那个走 `xy-bug-fix` 体系)

---

## Scope

### In Scope

(从「What Changes」提炼成可验收的能力清单)

1. **新建问题工作流**:模态向导强制收齐三项必给信息 + 多文件日志上传 + 按"一包一目录"解压
2. **问题列表侧栏**:扫描 `~/work/customer-onsite-analysis/<YYYYMMDD-*>/`,显示客户/状态/迭代/数据库/最后修改时间
3. **分析对话流**:复用 `claude-sdk.js` 驱动 Claude,Claude 的 `cwd` 锁定到问题目录;用户/AI 消息按主流 chat UI 风格区分对齐;证据/根因/阻塞/SQL 卡片内联
4. **状态机**:每个问题四态 `pending_info / analyzing / confirmed / blocked`;头部 info-chip 与侧栏徽章同步
5. **配置文件驱动下拉**:`config/customer-analysis.json` 是客户/迭代的单一真相源;运行时 mtime 变化触发前端下拉热更新
6. **不涉及三方对接联动**:选中「不涉及三方对接」时自动隐藏头部 third-bridge 分支 chip、跳过 third-bridge 切分支动作
7. **纪律可视化**:traceId 0 命中 → 强制 `blocked`;软化词高亮;证据/阻塞/SQL 卡片类型识别与渲染
8. **新路由注册**:`/onsite/*` 在主应用里挂上,带 nav 入口;主应用 provider 切换器在 onsite 路由下被锁定为 `claude`

### Out of Scope

(从上文「Out of Scope」继承,这里不重复)

---

## Impact

### Affected Code Areas

| 区域 | 形式 | 涉及文件(预估) |
|---|---|---|
| 路由与导航 | Modify | `src/App.tsx`(`<Route path="/onsite/*" ...>`)与 `src/components/sidebar/` 入口按钮 |
| 页面 | Create | `src/components/onsite-analysis/{OnsiteLayout,IssueListSidebar,OnsiteChatStream,NewIssueWizard,StatusBadge,EvidenceCard,BlockedCard,RootCauseCard,SqlCard}.tsx` |
| 状态管理 | Create | `src/stores/onsiteStore.ts`(选中问题、状态机、上传进度) |
| 服务端 | Create | `server/modules/onsite-analysis/{index,onsite.routes,onsite.service,config.service,problem.service,log-unpack.service}.ts` |
| 配置 | Create(已存在) | `config/customer-analysis.json`(只读) |
| 数据库 | Modify | `server/modules/database/schema.ts` + `migrations.ts` 新增 `onsite_problems` / `onsite_files` 表 |
| 共享类型 | Create | `shared/onsite-types.ts`(`ProblemId` / `ProblemStatus` / `ConfigCustomer` 等) |
| 测试 | Create | `server/modules/onsite-analysis/tests/{config,problem,log-unpack,state-machine}.test.ts` + `src/components/onsite-analysis/__tests__/*.tsx` |
| 工具脚本 | Create | `scripts/validate-no-hardcoded-customers.sh` 静态扫描(进 CI) |

### Affected APIs

- `GET /api/onsite/problems` —— 列表
- `GET /api/onsite/problems/:id` —— 详情
- `POST /api/onsite/problems` —— 新建(创建目录 + 写 `problem.json`)
- `PATCH /api/onsite/problems/:id` —— 改状态(带理由)
- `POST /api/onsite/problems/:id/files` —— 多文件上传(并行解压)
- `GET /api/onsite/config` —— 返回 `customer-analysis.json` 解析后的 `{ customers, iterations }` + mtime(供前端做热加载)
- WebSocket 协议扩展:`chat` 通道的 spawnFns 不变;**新增** `onsite` 通道路径 `/onsite/ws`,语义与 `chat` 相同但 `cwd` 强绑

### Affected Dependencies

- 新增 npm:无(都用 `react / react-dom / zustand / express / ws / chokidar / unzipper / ajv`,均已存在)
- 新增 skill:无(本变更用 `xy-bug-fix` 的现成纪律,不新写 skill)
- 数据库:在 `.cloudcli/auth.db` 加表,无外部依赖

### Not Affected

- `server/cursor-cli.js` / `server/gemini-cli.js` / `server/openai-codex.js` / `server/opencode-cli.js` 不变
- `electron/` 不变(主应用已能跑,onsite 走 Web 路由,Electron 形态照旧)
- `customer-onsite-analysis/CLAUDE.md` 不变(那是给终端 agent 用的,不动)

---

## Capabilities

### New Capabilities

(为本次新增;后续 `specs/` 会展开成 MUST/SHALL 契约)

- `onsite.issue.create` —— 新建向导 + 目录创建 + 元数据落盘
- `onsite.issue.list` —— 扫描 + 元数据读取
- `onsite.issue.state` —— 状态机迁移(带审计)
- `onsite.issue.chat` —— Claude 会话绑定问题 cwd
- `onsite.file.upload` —— 多文件并行解压
- `onsite.config.read` —— 读取 + mtime 报告
- `onsite.discipline.trace_id_blocked` —— 监听 `grep` 输出,命中 0 → 切 `blocked`
- `onsite.discipline.softening_warn` —— 软化词高亮
- `onsite.no_third_party` —— 「不涉及三方对接」联动

### Modified Capabilities

无。本次变更不修改 xy-claudecodeui 现有能力(Chat / Shell / File / Git / MCP / Provider 切换等),仅新增一个并列工作台路由。
