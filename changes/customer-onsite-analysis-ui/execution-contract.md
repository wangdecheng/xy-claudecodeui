# Execution Contract

> 转换自 `proposal.md` + `specs/` + `design.md` + `tasks.md`,作为 plan→execute 的唯一交接层。
> 本合同未获得用户明确批准前,**不得进入实现阶段**。
> 本版本为 **第二轮增量**(2026-07-06):把 prototype HTML 与实现的字段/交互差距沉淀为 hard contract,新增 Batch 9(纯前端对齐)与 Batch 10(closure diff 门禁)。
> 上一轮 47 commits 已 ship(release notes 已归档),本轮仅追加 Batch 9 + 10。

## Intent Lock

- **变更名称**:`customer-onsite-analysis-ui`(第二轮增量)
- **本轮要解决的问题**:首轮 ship 后,UI 实际效果与 `design-prototypes/customer-onsite-analysis/index.html` 差距大 —— 缺 17 项字段/交互(日期选择器、副标题、dz-note、客户下拉后缀、客户首项联动、数据库「其他」、ESC 关闭、问题主标题、上传一气呵成、业务阶段分组、全宽按钮、消息头像、msg-role、composer hint、composer placeholder、空对话留白、证据三色高亮)。同时缺 closure diff 门禁,后续批次无法强制对齐 prototype。本轮把 prototype 字段全部沉淀为 MUST,新增自动化 diff 脚本作为 closure 强制门禁。
- **范围内**(本轮新增):
  - 把 prototype HTML 的 17 项字段/交互追加到 `specs/issue-create.md` / `specs/issue-chat.md` / `specs/issue-list.md` 作为 MUST 条款
  - `tasks.md` 验收章节新增「Prototype field alignment checklist」17 条自动 + 3 条人工
  - `tasks.md` 追加 Batch 9(12 个 prototype 字段对齐 Task)+ Batch 10(4 个 closure diff Task)
  - 实施:补齐上述字段(日期选择器、客户后缀、msg-role、头像、composer hint、modal 副标题、dz-note、ESC 关闭、问题主标题字段、modal 内一气呵成上传)
  - 新增 `scripts/diff-onsite-ui-vs-prototype.sh` 作为 release-archivist 强制门禁
- **第一轮历史范围内**(保留不动):
  - 新建路由 `/onsite/*`(问题列表侧栏 + 新建向导 + 对话流 + 卡片化渲染)
  - 服务端模块 `server/modules/onsite-analysis/`(problem.service / config.service / state-machine.service / log-unpack.service / 三个 discipline 中间件)
  - 数据库增量:`sessions` 表加 `kind` 列 + 5 张新表(`onsite_problems` / `onsite_files` / `onsite_state_audit` / `onsite_discipline_log` / `migrations_applied`)
  - 配置文件:`config/customer-analysis.json` 单例读取 + mtime 热加载 + JSON schema 校验
  - 纪律护栏:traceId 多信号检测 + 软化词高亮 + 写原日志双层防护
  - 状态机:四态 `pending_info/analyzing/blocked/confirmed` + `abandoned` 归档态
  - 回归保护:Batch 0 chat 路径回归基线 + Batch 5.5 强制门禁
  - migration 事务包裹 + `verifyMigrations` 启动校验
- **范围外**(本轮 + 第一轮均不动):
  - Claude Agent SDK 本身(`server/claude-sdk.js` 零改动)
  - Cursor/Codex/Gemini/OpenCode provider 抽象(本次仅对接 Claude)
  - 现有 chat session / Shell / File / Git / MCP 等通用能力
  - 客户现场分析以外的"研发内部 bug 排查"(走 `xy-bug-fix` 体系)
  - `~/work/customer-onsite-analysis/CLAUDE.md`(给终端 agent 用的,本次只新增 UI 入口)
  - 移动端原生 App
  - 跨问题关联分析 / 主动周期巡检 / 后台 agent 任务
  - 本轮**不**重写任何已 ship 的功能模块,仅追加字段级 MUST 与新增脚本

## Approved Behavior

### 第一轮已批准(从 10 份 spec 提取,本轮保留)

- **issue-create**:三项必给信息强制采集;客户/迭代下拉由配置驱动;目录与 `problem.json` 约定;DB 元数据登记
- **issue-list**:扫描 `~/work/customer-onsite-analysis/<YYYYMMDD-*>/`;兼容老式目录无 `problem.json`;按状态分组排序;1 秒内实时刷新
- **issue-state**:四态(加 `abandoned` 归档)状态机;reason ≥ 8 字符;UI 徽章与头部同步;广播 `problem:<id>:state-changed`
- **issue-chat**:Claude `cwd` 强绑问题目录;切换/新建后 cwd 重定;Provider 锁为 Claude;用户消息右蓝气泡 / AI 左平铺 / 卡片化
- **file-upload**:多文件并行解压(一包一目录 `unpacked-<n>/`);单包 ≤ 200MB / 总数 ≤ 20;解压失败回滚(207);元数据落 `onsite_files`
- **config-read**:单例 + mtime 监听 + JSON schema 校验 + API 暴露;零硬编码 + CI 静态扫描
- **no-third-party**:客户选「不涉及三方对接」时 UI 联动 + 服务端跳过切分支;配置变更不破坏既有 null 问题
- **discipline-softening**:软化词识别与 `<softening>` 标签注入;UI 琥珀波浪下划线;`POST confirm-root-cause` 含软化词返 422;落 `onsite_discipline_log`
- **discipline-trace-id**:traceId 0 命中自动 `blocked`;多信号融合(主信号 AI 文本 + 强信号 grep/rg/ag/ack + 弱信号 suspect 非自动 blocked);envelope `discipline.{traceIdEmpty,traceIdSuspect}` flag 替代 XML 标签;chat 路径零影响
- **discipline-write-protection**:中间件挂载到 `kind='onsite'` 路径;双正则匹配(写动作 + 原始路径);触发落库 + envelope `discipline.writeProtection` flag,**不**自动 blocked;spawn 时 system prompt 注入「HARD RULE - 现场纪律」置顶规则

### 本轮新增 MUST(从 prototype HTML 字段提取)

#### issue-create(增量)
- **REQ-1.5**:问题日期字段(`<input type="date">`,默认今日),作为 cwd 目录名 `YYYYMMDD-` 与 `problem.json.createdAt` 的一致来源;未来日期 → 400 `Bad Request`
- **REQ-1.6**:Modal 副标题必须显示「三项必给信息用于定位服务分支与 SQL 方言，缺任一项将无法开始分析。目录会按 `YYYYMMDD-客户简称` 自动创建。」
- **REQ-1.7**:dz-note 琥珀色提示「每个压缩包将解压到独立子目录（pod-1/、pod-2/…），禁止覆盖——避免排查盲区」(modal 打开期间始终可见)
- **REQ-1.8**:客户下拉 label 自动追加分支后缀:label 不含「（」/「(」且 label !== branch 时,自动追加「（{branch}）」;首项 `branch=null` 不追加
- **REQ-1.9**:客户首项「不涉及三方对接」联动隐藏头部 third-bridge chip(无服务端往返)
- **REQ-1.10**:数据库下拉末项「其他」(`value="other"`),服务端映射为 `null` + 进 `pending_info`,显示提示「未指定数据库类型,请稍后在现场补充」
- **REQ-1.11**:Modal 支持 ESC 关闭 + 点击遮罩关闭(点击 modal 卡片内不关)
- **REQ-1.12**:问题主标题字段(title,可选,≤80 字符);头部标题格式 `{customer} · {title}`,title 为空时回退 `{customer} · 现场问题`
- **REQ-1.13**:新建+上传一气呵成——LogUploader 在 modal 内始终可见,创建前 disabled + 提示「请先创建问题再上传文件」,创建成功后 modal 不关闭、dropzone 立即可上传(无两阶段)

#### issue-chat(增量)
- **REQ-4.5**:每条消息必须显示头像——用户「我」30×30 灰底右对齐,AI「C」30×30 Claude 橙底(`hsl(14 55% 55%)`)左对齐
- **REQ-4.6**:每条消息必须显示 msg-role 行——用户「现场反馈」(`text-align: right`),AI「Claude · 取证顺序：日志 → 源码 → DB」(后端若能推断当前取证阶段则高亮对应阶段)
- **REQ-4.7**:Composer 底部 hint 行(11px 居中)必须显示「仅对接 Claude Code · 工作目录锁定在 <cwd 完整绝对路径>」,cwd 切换时同步更新
- **REQ-4.8**:Composer placeholder 工作流化文案「补充信息、粘贴日志片段，或让 Claude 继续下一步取证…」(禁用技术化 Enter/Shift+Enter 键名)
- **REQ-4.9**:空对话流不显示"No messages yet"等居中文案(保持空白)
- **REQ-4.10**:证据卡片 `<card type="evidence">` body 需保留 logquote 三色高亮——`hl` 琥珀加粗(关键字 / 注释行)、`err` 红色(命中 0)、`ok` 绿色(命中 ≥1)

#### issue-list(增量)
- **REQ-2.6**:按业务阶段分组而非按 5 状态分组——「进行中」(blocked/analyzing/pending_info)与「已归档」(confirmed/abandoned)两个 section header;空组不渲染
- **REQ-2.7**:「新建现场问题」按钮为全宽主按钮(`width: 100%`),不是角落小图标

#### closure-gate(新增能力类别)
- **REQ-batch10.diff-script**:`scripts/diff-onsite-ui-vs-prototype.sh` 必须能跑通,输出 `prototype-diff-report.md`(17 条 checklist + PASS/FAIL + 证据);17 - FAIL_count 总分
- **REQ-batch10.ci-step**:CI 流水线加 `diff-onsite-ui-vs-prototype.sh` step,失败阻塞 merge
- **REQ-batch10.archivist-checklist**:release-archivist 必跑 diff 脚本并把 `prototype-diff-report.md` 作为 release notes 附件
- **REQ-batch10.reviewer-checklist**:code-reviewer 收到 PR diff 后必须打开 prototype HTML + 实施 UI 并排截图对比

### 关键场景

- 共 60+ 条 GIVEN/WHEN/THEN,详见 `specs/`
- 本轮新增 19 条 Scenario(REQ-1.5~1.13 共 14 条 + REQ-4.5~4.10 共 9 条 + REQ-2.6/2.7 共 3 条,部分 spec 复用多 scenario)

### 验收检查

- **每条 THEN 子句成为自动化测试断言**(Vitest / RTL / node:test)
- **Prototype field alignment checklist**(本轮新增):17 条自动 + 3 条人工目视,closure 阶段必跑,任何 FAIL 项必须先修才能归档
- **11 条 Success Criteria**(第一轮) + **17 条 Prototype alignment**(本轮) = 28 条 closure 验收清单

## Design Constraints

- **架构约束**(从 `design.md` 提取,**本轮不动**):
  - **D-1**:onsite session 共用 `sessionsDb`,加 `kind` 字段
  - **D-2**:onsite chat 复用现有 `chat-websocket.service.ts`,**不新开通道**
  - **D-3**:`problem.json` 是权威,DB 是冗余
  - **D-4**:配置文件由后端读 + `GET /api/onsite/config` 暴露
  - **D-5**:状态机为 service,纯函数 + 表驱动
  - **D-6**:纪律中间件挂载在 chat 消息出口,通过 `enabledFor(ws) → ws.kind === 'onsite'` 隔离
  - **D-7.1**:`disallowedTools` 注入 7 类 glob × 7 种写动作
  - **D-7.2**:`discipline-write-protection` 中间件,运行时审计 + system prompt 软约束
  - **D-8**:UI 不允许手动输入 = 组件层(纯 `<select>`)+ CI 静态扫描双层防线
  - **D-9**:traceId 检测从单一命令匹配升级为多信号融合
- **本轮新增设计约束**(从 prototype HTML 提取):
  - **D-10**:`ProblemRecord.title?: string`(可选字段);所有读 title 的代码路径必须容错 undefined(本轮只在 onsite 路径用,chat 路径不应受影响)
  - **D-11**:Prototype HTML 是 closure 验收基准;`design-prototypes/customer-onsite-analysis/index.html` 在 PR 描述里必须能被引用
  - **D-12**:diff 脚本是静态分析 + DOM probe 组合,严禁用「视觉接近」替代字段级断言
- **接口约束**:
  - 不动 `claude-sdk.js:589-594` 的 `canUseTool` 拒绝分支
  - 不动 `claude-sdk.js:208` 的 `disallowedTools` 透传逻辑
  - 不动 `chat-websocket.service.ts:18-22` 的 `ProviderSpawnFn` 签名
  - 不动 `customer-onsite-analysis/CLAUDE.md`
  - **本轮新增**:`shared/onsite-types.ts` 的 `ProblemRecord` 加可选字段 `title?: string`(后向兼容)
- **依赖约束**:
  - 不新增 npm 包
  - 不新增 skill
  - 不修改 `customer-onsite-analysis/` 仓库
  - **本轮新增**:`scripts/diff-onsite-ui-vs-prototype.sh` 可使用 `jsdom`(若未装则用 `node:test` + `react-dom/server` 渲染做轻量 DOM probe),**优先**用项目已装的依赖
- **数据约束**:
  - `sessions.kind` CHECK 约束不变
  - `problem.json` 新增可选字段 `title`(长度 ≤ 80)
  - `onsite_problems.title` 列加 `TEXT`(nullable)
  - 第一轮 schema 完整保留,不做破坏性变更

## Task Batches

> 第一轮共 9 个 Batch(0~8,5.5 嵌在 Batch 5 后);**本轮新增 Batch 9(prototype 字段对齐)+ Batch 10(closure diff)**。
> Batch 9 与 Batch 8 无依赖关系(可并行);**Batch 10 必须在 Batch 9 完成后才能跑**(diff 脚本才有意义)。

### Batch 0~8(第一轮已 ship,本轮不重跑)

详见 `tasks.md` §Batch 0~8。**关键回看**:
- Batch 0 — chat 路径回归基线(前置,所有 Batch 依赖)
- Batch 5.5 — chat 回归门禁(后置,Batch 5 结束后强制跑)
- Batch 8.4 — 11 条 Success Criteria 人工验收

### Batch 9 — Prototype 字段对齐(本轮,纯前端增量)

- **目标**:把 prototype HTML 的 17 项字段/交互补齐到 React 实现
- **输入**:Batch 7 的前端组件骨架(已存在但字段不全)
- **输出**:11 个 Task 实施 + 1 个 i18n 收口 Task,共 12 个 Task
  - **Task 9.1** — NewIssueWizard 加 `<input type="date">`(REQ-1.5)+ `ProblemService.create` 接 `date` 字段 + 未来日期 400 校验
  - **Task 9.2** — Modal 副标题 + dz-note 琥珀提示(REQ-1.6 / REQ-1.7)+ i18n `wizard.subtitle` / `wizard.dzNote`
  - **Task 9.3** — 客户下拉 label 后缀规则(REQ-1.8):label 不含「（」/「(」且 label !== branch 时追加
  - **Task 9.4** — 客户首项联动隐藏 third-bridge chip(REQ-1.9):`AnalysisInfoChips` 接 `noThirdBridge` prop
  - **Task 9.5** — 数据库「其他」项 + title 字段(REQ-1.10 / REQ-1.12):`DATABASE_KINDS` 末项加 `other` + `ProblemRecord.title?: string` + 头部 `{customer} · {title}` 渲染
  - **Task 9.6** — Modal ESC + 遮罩关闭(REQ-1.11):`onKeyDown` + backdrop click stopPropagation
  - **Task 9.7** — LogUploader 在 modal 内始终可见(REQ-1.13):移除条件渲染,改为始终渲染 + `problemId === null` 时 disabled
  - **Task 9.8** — IssueListSidebar 业务阶段分组 + 全宽新建按钮(REQ-2.6 / REQ-2.7):5 状态 → 2 业务阶段;移除角落小+号,顶部加全宽按钮
  - **Task 9.9** — MessageBubble 头像 + msg-role + composer hint(REQ-4.5 / REQ-4.6 / REQ-4.7)
  - **Task 9.10** — Composer placeholder + 空对话(REQ-4.8 / REQ-4.9):替换 placeholder,移除「No messages yet」
  - **Task 9.11** — EvidenceCard 三色高亮(REQ-4.10):加 `HL_HIT` / `OK_HIT` 正则,渲染 3 类 span
  - **Task 9.12** — i18n 全量对齐:把 Batch 9 硬编码中文全部迁到 i18n
- **完成标准**(每条 Task 都有):
  - Vitest / RTL 单元测试覆盖字段存在性 + 行为
  - DOM probe:断言对应 `data-testid` 存在 + 文案匹配
  - 单个 commit,message 标注 REQ 编号
- **不修改**:`claude-sdk.js` / `chat-websocket.service.ts` / `chat-run-registry.service.ts` / `claude-agent-sdk` 配置 / `sessions` 表基础结构(只加 `title` 列,nullable)
- **风险**:`ProblemRecord.title` 是新增可选字段,现有 chat/onsite 路径读 title 必须容错 undefined。**Task 9.5 必须含向后兼容测试**

### Batch 10 — Closure Diff 脚本(本轮,质量门禁)

- **目标**:为 closure 阶段提供自动化 prototype 字段对齐校验;把 diff 报告作为 release notes 必交附件
- **输入**:Batch 9 完成的字段实现
- **输出**:4 个 Task
  - **Task 10.1** — `scripts/diff-onsite-ui-vs-prototype.sh`:解析 prototype HTML 关键字段,对照实现侧 17 条 checklist 跑检测,输出 `prototype-diff-report.md`(PASS/FAIL + 证据);`exit 0` 当且仅当全部 PASS
  - **Task 10.2** — `.github/workflows/*.yml` 加 `diff-onsite-ui-vs-prototype.sh` step,失败阻塞 merge,成功上传 report 作为 PR artifact
  - **Task 10.3** — `docs/release-archivist-checklist.md`(新建):closure 阶段必跑 diff 脚本,report 作为 release notes 附件
  - **Task 10.4** — `docs/code-reviewer-checklist.md`(新建):code-reviewer 收到 PR 后必打开 prototype HTML + 实施 UI 并排截图对比,截图作为 PR 评论附件
- **完成标准**:
  - 故意 revert 一个 Batch 9 Task → diff 脚本 exit 1 + report 标 FAIL → 恢复 → exit 0
  - CI 在 PR 上跑 `diff-onsite-ui-vs-prototype.sh` 失败 → 红灯
  - release-archivist checklist 强制引用 diff 报告
- **不修改**:任何业务代码;纯脚本 + 文档

## Test Obligations

- **必须先从失败测试开始的行为**(TDD 铁律):
  - 第一轮已有的所有 TDD 任务保留(参见 `tasks.md` §Test Obligations)
  - **本轮新增 TDD 任务**:
    - `ProblemService.create` 接 date 字段 + 未来日期 400 校验(Task 9.1)
    - `CustomerSelect` label 后缀规则 3 case(Task 9.3)
    - `AnalysisInfoChips` branch=null 不渲染 chip(Task 9.4)
    - `DatabaseSelect` 含 other 项 + 提示(Task 9.5)
    - `NewIssueWizard` ESC 关闭 + 遮罩关闭(Task 9.6)
    - `NewIssueWizard` 一气呵成(modal 不关,dropzone enabled)(Task 9.7)
    - `IssueListSidebar` 业务阶段二分 + 全宽按钮(Task 9.8)
    - `OnsiteChatStream` 头像 + msg-role + composer hint(Task 9.9)
    - `OnsiteChatStream` placeholder + 空对话留白(Task 9.10)
    - `EvidenceCard` 三色高亮 fixture(Task 9.11)
- **必需的边界情况**:
  - 选了未来日期 → 400 `Bad Request`(Task 9.1)
  - 客户 label 自带括号 → 不重复后缀(Task 9.3)
  - 客户 label === branch → 不重复后缀(Task 9.3)
  - 客户首项 branch=null → 不追加后缀 + 头部 chip 隐藏(Task 9.3 + 9.4)
  - 数据库选「其他」→ 服务端存 null + pending_info(Task 9.5)
  - title 超过 80 字符 → 前端 disabled + 红字(Task 9.5)
  - ESC 按键 → modal 关(Task 9.6)
  - 点 modal 卡片内 → 不关(Task 9.6)
  - 创建前上传 → 不发请求 + 提示(Task 9.7)
  - 创建后 modal 不关 + dropzone 可用(Task 9.7)
  - ProblemRecord.title 缺失 → 头部回退「现场问题」(Task 9.5 向后兼容)
  - 空 messages 数组 → 不显示「No messages yet」(Task 9.10)
- **回归敏感区域**(Batch 0 + 5.5 + 本轮新增 diff):
  - `server/claude-sdk.js` 任何改动 → exit 1(`diff-chat-impact.sh`)
  - `server/modules/chat/` 任何改动 → exit 1
  - `chat-websocket.service.ts` 任何改动 → exit 1
  - **本轮新增**:`ProblemRecord.title` 字段缺失 → 不应让 chat 路径崩(由 Batch 9.5 向后兼容测试覆盖)
  - **本轮新增**:prototype 字段缺失 → diff 脚本 exit 1,阻塞 merge

## Execution Mode

- **模式**:`SDD`(Spec-Driven Development)
- **选择理由**(沿用第一轮,本轮不切换):
  - 变更规模大(本轮新增 19 条 REQ + 16 个 Task)
  - 纪律护栏是"安全核心",任何启发式偏差都会让约束失效
  - 多模块跨层(纯前端 + 共享类型微调),SDD 的「spec→test→impl」节奏比 inline 更可控

## Verification Dimensions

| 维度 | 状态 | 发现 |
|------|------|------|
| Completeness | Pending | 待 build-executor 跑后勾选 |
| Correctness | Pending | 待 build-executor 跑后勾选 |
| Coherence | Pending | 待 build-executor 跑后勾选 |
| **Prototype Alignment(本轮新增)** | Pending | 待 Batch 10 diff 脚本产出 0 FAIL |

**总体结论**:Pending(待用户批准后进入 build-executor 验证)

## Review Gates

- **强制审查点**(spec-superflow:code-reviewer):
  - **Batch 0 收尾**:chat 路径回归基线脚本就位后(第一轮已 ship,本轮只回看)
  - **Batch 2 收尾**:migrations 事务写完后(第一轮已 ship)
  - **Batch 4 收尾**:三个纪律中间件全部就位后(第一轮已 ship)
  - **Batch 5.5 收尾**:chat 回归门禁通过后(第一轮已 ship)
  - **Batch 7 收尾**:前端页面完成后(第一轮已 ship)
  - **Batch 8 收尾**:11 条 Success Criteria 全部勾完(第一轮已 ship)
  - **Batch 9 收尾(本轮新增)**:12 个 prototype 字段对齐 Task 完成后 + diff 脚本(Batch 10.1)产出 0 FAIL,**且 reviewer 打开 prototype HTML 与实施 UI 并排截图对比**(由 code-reviewer-checklist.md 强制)
  - **Batch 10 收尾(本轮新增)**:diff 脚本 + CI step + release-archivist checklist + code-reviewer checklist 全部就位;**closure 阶段强制跑 diff,任何 FAIL 必须先修**
- **阻塞类别**(触发立即回退到 bridging 或 specifying):
  - chat 路径 baseline diff 出现 pass 数下降(第一轮已 ship,本轮回看)
  - `migrations` 事务回滚测试失败(第一轮已 ship)
  - 任何 `claude-sdk.js` 改动未在 PR 描述里说明(第一轮已 ship)
  - 软化词 `confirm-root-cause` 阻断测试失败(第一轮已 ship)
  - `validate-no-hardcoded-customers.sh` CI 拦截到硬编码(第一轮已 ship)
  - **本轮新增**:Batch 9 实施后 diff 脚本 ≥ 1 FAIL → 阻塞 merge
  - **本轮新增**:code-reviewer 未提供 prototype + 实施并排截图 → 不收尾
  - **本轮新增**:release-archivist 收口时未跑 diff 脚本 → 不归档

## Escalation Rules

- **何时回退到 `specifying`**(重新打开 need-explorer + spec-writer):
  - 用户要求新增/删除某条 REQ(范围变化)
  - 发现某条 spec 的 GIVEN/WHEN/THEN 与实际 Claude 行为无法对齐
  - 客户/迭代下拉需求从"配置驱动"改为"允许手动输入"(D-8 约束被破)
  - 跨问题关联分析或主动周期巡检被加进 scope
  - **本轮新增**:用户要求 prototype 字段「可选 / 不必对齐」→ 重新打开 spec-writer 修订 MUST
  - **本轮新增**:发现 prototype HTML 自身有内部矛盾(同一字段在两处定义不同)→ 重新走 need-explorer 决策
- **何时回退到 `bridging`**(重新打开 contract-builder):
  - 任何 Batch 拆分合并(Task 数量变化 ≥ 20%)
  - 纪律护栏三层融合(主/强/弱)任一层被移除或换机制
  - `disallowedTools` 7 类 glob 任一类被移除
  - 状态机新增/删除状态
  - chat 路径回归策略从「前置 baseline + 后置 diff」改为其他形式
  - **本轮新增**:Batch 9 / Batch 10 范围变化(新增 prototype 字段 / 新增 diff 类别)→ contract 重生
- **何时不得继续实现**(stop-the-line):
  - Batch 0 baseline 跑不通(第一轮已 ship)
  - `verifyMigrations` sha 不一致(第一轮已 ship)
  - 任何中间件挂在 `kind='chat'` 的 ws 上(第一轮已 ship)
  - 任何 `claude-sdk.js` / `chat-websocket.service.ts` 改动未经 PR 描述声明(第一轮已 ship)
  - **本轮新增**:`ProblemRecord.title` 字段缺失导致 chat 路径崩溃(由 Batch 9.5 向后兼容测试覆盖)
  - **本轮新增**:diff 脚本无法解析 prototype HTML(prototype 文件被破坏)→ 报告 prototype 损坏而非 mock 通过

## Coverage Cross-Check

### 第一轮(已 ship)

- **issue-create**(4 REQ)→ Batch 1 + 2 + 7 ✓
- **issue-list**(5 REQ)→ Batch 2 + 3 + 6 + 7 ✓
- **issue-state**(4 REQ)→ Batch 3 ✓
- **issue-chat**(4 REQ)→ Batch 4 + 6 + 7 ✓
- **file-upload**(4 REQ)→ Batch 5 ✓
- **config-read**(4 REQ)→ Batch 1 + 8 ✓
- **no-third-party**(3 REQ)→ Batch 2 + 4 + 7 ✓
- **discipline-softening**(4 REQ)→ Batch 4 + 7 ✓
- **discipline-trace-id**(7 REQ)→ Batch 4 + 7 ✓
- **discipline-write-protection**(5 REQ)→ Batch 4 + 5 + 7 ✓

### 本轮新增

- **issue-create(增量,9 REQ:1.5/1.6/1.7/1.8/1.9/1.10/1.11/1.12/1.13)**→ Batch 9(Task 9.1~9.7),共 7 个 Task 覆盖 9 条 REQ ✓
- **issue-list(增量,2 REQ:2.6/2.7)**→ Batch 9(Task 9.8),共 1 个 Task 覆盖 2 条 REQ ✓
- **issue-chat(增量,6 REQ:4.5/4.6/4.7/4.8/4.9/4.10)**→ Batch 9(Task 9.9~9.11),共 3 个 Task 覆盖 6 条 REQ ✓
- **closure-gate(新增能力类别,4 项:diff-script / ci-step / archivist-checklist / reviewer-checklist)**→ Batch 10(Task 10.1~10.4),共 4 个 Task 覆盖 4 项 ✓

**无 coverage gap**。

## 关键交接规则(摘要)

### 第一轮保留

1. **TDD 不可妥协**:每条 Task 必须「Test 写 → 失败 → 实现 → 通过」四段
2. **chat 路径零回归**:Batch 0 baseline 必须先建,Batch 5.5 门禁必须过
3. **纪律中间件必须挂 `enabledFor(ws) → ws.kind === 'onsite'`**
4. **migration 整体事务**:失败整体回滚,启动时 `verifyMigrations` 校验 sha
5. **配置 JSON 改一半时**:API 返回 last-known-good + `status='INVALID'`
6. **`disallowedTools` 7 类 glob 全部走 `toDisallowPatterns`**
7. **envelope `discipline` flag**:前端按 flag 渲染徽章,不解析 XML 标签
8. **11 条 Success Criteria** 在 Batch 8 验收时逐条勾

### 本轮新增

9. **Prototype HTML 是 closure 验收基准**:任何 `design-prototypes/customer-onsite-analysis/index.html` 有的字段,实现必须有;无则该 REQ 不算完成
10. **diff 脚本是 closure 强制门禁**:`scripts/diff-onsite-ui-vs-prototype.sh` 必须跑通且 0 FAIL;任何 FAIL 项必须先修才能 release
11. **17 条 Prototype alignment**(自动)+ 3 条人工目视,closure 阶段必勾;未勾选项一律不准 closure
12. **`ProblemRecord.title` 必须向后兼容**:可选字段,所有读 title 的代码路径必须容错 undefined;chat 路径不应受影响
13. **code-reviewer 必跑 prototype 对照**:reviewer 收到 PR diff 后,打开 prototype HTML + 实施 UI 并排截图,截图作为 PR 评论附件
14. **i18n 全量收口**:Batch 9 硬编码中文必须在 Task 9.12 全部迁到 i18n,不留技术债
15. **本轮不重跑第一轮**:Batch 0~8 已 ship,不再触发回归;Batch 9 仅前端增量,`diff-chat-impact.sh` 应保持空 diff(允许例外:`shared/onsite-types.ts` 加 `title?: string` + `ProblemService.create` 接 `title`)
