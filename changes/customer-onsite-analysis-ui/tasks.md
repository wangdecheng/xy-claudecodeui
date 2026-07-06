# tasks: customer-onsite-analysis-ui

> 把 `proposal.md` + `specs/` + `design.md` 拆成 2-5 分钟可执行的原子任务。
> 任务按依赖顺序组织,每个 Batch 结束必须 commit。
> 严格使用 TDD:每条写代码的任务必须先写失败测试 → 跑测试确认失败原因正确 → 写最小实现 → 跑测试确认通过。

---

## File Structure

> 本变更将创建/修改的文件清单。**`Create`** 是新文件;**`Modify`** 是已存在文件。
> 每行一句话说清职责,后文任务里按此精确路径操作。

### 配置 / 数据库
- **Create** `config/customer-analysis.json` — 客户/迭代下拉选项的真源(13 customers + 2 iterations)
- **Create** `config/discipline-words.json` — 软化词白名单(中英文混合)
- **Create** `config/json-schemas/customer-analysis.schema.json` — 配置文件 JSON schema,运行时校验用
- **Modify** `server/modules/database/schema.ts:100-117` — `sessions` 表新增 `kind` / `cwd` / `third_bridge_branch` / `iteration` / `database` 列
- **Modify** `server/modules/database/migrations.ts` — 新增 5 个表的 `db.exec(...)` + `ALTER TABLE sessions` 增量 + 索引
- **Create** `server/modules/database/repositories/onsite-problems.db.ts` — onsite_problems 表 CRUD
- **Create** `server/modules/database/repositories/onsite-files.db.ts` — onsite_files 表 CRUD
- **Create** `server/modules/database/repositories/onsite-state-audit.db.ts` — 状态机审计
- **Create** `server/modules/database/repositories/onsite-discipline-log.db.ts` — 软化词命中日志

### 服务端业务模块
- **Create** `server/modules/onsite-analysis/index.ts` — 路由聚合
- **Create** `server/modules/onsite-analysis/config.service.ts` — 读 + 监听 `customer-analysis.json` mtime,JSON schema 校验
- **Create** `server/modules/onsite-analysis/state-machine.service.ts` — 7 条合法迁移的纯函数 + 审计
- **Create** `server/modules/onsite-analysis/problem.service.ts` — 目录创建 / problem.json 写 / 表写;cwd 越界 403
- **Create** `server/modules/onsite-analysis/log-unpack.service.ts` — 多 zip 并行解压,一包一目录,失败回滚
- **Create** `server/modules/onsite-analysis/onsiteWatcher.ts` — chokidar 监听 onsite 根目录,1 秒内广播 `problems:changed`
- **Create** `server/modules/onsite-analysis/onsite.routes.ts` — `GET/POST/PATCH /api/onsite/*` 路由(无 WS)
- **Create** `server/modules/onsite-analysis/discipline/discipline-softening.middleware.ts` — 软化词扫描 + 标签注入 + 落库
- **Create** `server/modules/onsite-analysis/discipline/discipline-trace-id.middleware.ts` — grep 0 命中检测 + emit blocked
- **Create** `server/modules/onsite-analysis/discipline/discipline-write-protection.middleware.ts` — 写原日志软层审计(MCP/curl/awk 兜底,防 C-2 软层)

### 服务端 WebSocket 与 SDK 集成
- **Create** `server/modules/websocket/services/onsite-websocket.service.ts` — kind=onsite 的消息分发,挂载两个纪律中间件
- **Modify** `server/modules/websocket/services/chat-run-registry.service.ts:50-80` — 加 `kind` 过滤,不改变 chat 行为
- **N/A** `server/claude-sdk.js` — **不修改**;路径黑名单通过 `disallowedTools` 注入(见 Task 5.1)
- **Modify** `server/index.js:155-225` — 挂载 `/api/onsite` + 在 `wss` 注入 onsite 路径处理

### 前端:store + 类型 + i18n
- **Create** `shared/onsite-types.ts` — `ProblemId / ProblemStatus / ConfigCustomer / ConfigIteration / DisciplineLog` 等
- **Create** `src/stores/onsiteStore.ts` — zustand store:当前问题、列表、状态、上传进度
- **Create** `src/contexts/OnsiteWebSocketContext.tsx` — onsite kind WS 连接,挂在主 WebSocketProvider 旁

### 前端:页面与组件
- **Create** `src/components/onsite-analysis/OnsiteLayout.tsx` — 路由布局壳
- **Create** `src/components/onsite-analysis/IssueListSidebar.tsx` — 侧栏问题列表
- **Create** `src/components/onsite-analysis/IssueListItem.tsx` — 单条问题(状态徽章/chips/相对时间)
- **Create** `src/components/onsite-analysis/OnsiteChatStream.tsx` — 对话流主区(用户右气泡 / AI 左平铺 / 卡片渲染)
- **Create** `src/components/onsite-analysis/StatusBadge.tsx` — 状态徽章组件
- **Create** `src/components/onsite-analysis/CwdLockView.tsx` — 顶栏 cwd 锁定显示
- **Create** `src/components/onsite-analysis/NewIssueWizard.tsx` — 新建向导模态
- **Create** `src/components/onsite-analysis/CustomerSelect.tsx` — 客户下拉(纯 select,从 API 加载)
- **Create** `src/components/onsite-analysis/IterationSelect.tsx` — 迭代下拉
- **Create** `src/components/onsite-analysis/DatabaseSelect.tsx` — 数据库下拉
- **Create** `src/components/onsite-analysis/LogUploader.tsx` — 多文件拖拽上传
- **Create** `src/components/onsite-analysis/cards/EvidenceCard.tsx` — 🔍 证据卡片
- **Create** `src/components/onsite-analysis/cards/BlockedCard.tsx` — ⛔ 阻塞卡片
- **Create** `src/components/onsite-analysis/cards/RootCauseCard.tsx` — ✅ 已证实根因卡片
- **Create** `src/components/onsite-analysis/cards/SqlCard.tsx` — 📋 SQL 卡片
- **Create** `src/components/onsite-analysis/cards/CardRenderer.tsx` — 根据 `<card type="...">` 分发
- **Create** `src/components/onsite-analysis/SofteningTag.tsx` — 琥珀波浪线下划线
- **Create** `src/components/onsite-analysis/DisciplineCounter.tsx` — 头部「本会话软化词 N 处」
- **Create** `src/components/onsite-analysis/NoThirdPartyHint.tsx` — 选中「不涉及三方对接」时的提示

### 前端:路由与导航
- **Modify** `src/App.tsx:90-100` — 注册 `/onsite/*` 路由
- **Modify** `src/components/sidebar/view/Sidebar.tsx:1-90` — 顶部加「客户现场分析」入口按钮

### i18n
- **Create** `src/i18n/locales/zh-CN/onsite.json` — 中文文案
- **Create** `src/i18n/locales/en/onsite.json` — 英文文案
- **Modify** `src/i18n/index.ts` — 注册 onsite 命名空间

### 测试与 CI
- **Create** `server/modules/onsite-analysis/tests/config.service.test.ts` — 配置读取/校验/mtime
- **Create** `server/modules/onsite-analysis/tests/state-machine.test.ts` — 7 条合法边 + 7 条非法边
- **Create** `server/modules/onsite-analysis/tests/problem.service.test.ts` — 目录创建 / problem.json 落盘 / cwd 越界
- **Create** `server/modules/onsite-analysis/tests/log-unpack.service.test.ts` — 多 zip 并行 / 单包超限 / 损坏回滚
- **Create** `server/modules/onsite-analysis/tests/discipline-softening.middleware.test.ts` — 中英文软化词扫描
- **Create** `server/modules/onsite-analysis/tests/discipline-trace-id.middleware.test.ts` — grep 0 命中检测(主信号+强信号+弱信号三档)
- **Create** `server/modules/onsite-analysis/tests/discipline-write-protection.middleware.test.ts` — 双正则匹配 + chat 路径隔离
- **Create** `server/modules/onsite-analysis/tests/migration-rollback.test.ts` — 事务回滚 + verifyMigrations
- **Create** `src/components/onsite-analysis/__tests__/NewIssueWizard.test.tsx` — 三项必填校验 / 下拉加载
- **Create** `src/components/onsite-analysis/__tests__/OnsiteChatStream.test.tsx` — 消息对齐 / 卡片分发
- **Create** `scripts/regression-chat.sh` — chat 路径回归基线(Batch 0)
- **Create** `scripts/diff-chat-impact.sh` — chat 路径文件 diff 检测(Batch 0)
- **Create** `scripts/validate-no-hardcoded-customers.sh` — CI 静态扫描
- **Create** `scripts/diff-onsite-ui-vs-prototype.sh` — UI 实现 vs prototype 字段 diff 报告(Batch 10,closure 门禁)
- **Modify** `.github/workflows/*.yml` — PR 流水线加 `validate-no-hardcoded-customers.sh` + `regression-chat.sh` + `diff-chat-impact.sh` 三步
- **Modify** `.github/workflows/*.yml` — 在 PR 流水线加 `diff-onsite-ui-vs-prototype.sh`(Batch 10)

---

## Spec ↔ Task 矩阵(可追溯性)

> **Why**:10 份 spec 拆出 ~40 条 REQ,本变更拆出 ~30 个 Task。审阅者要能 5 秒内回答"每条 REQ 由哪个 Task 实现"和"每个 Task 实现哪几条 REQ"。本矩阵是 source of truth,任何新增 REQ 或 Task 必须双向更新。

| Spec | REQ | 标题 | 对应 Task | 备注 |
|---|---|---|---|---|
| **issue-create** | REQ-1.1 | 三项必给信息强制采集 | Task 7.2 | NewIssueWizard 必填校验 |
| issue-create | REQ-1.2 | 客户/迭代下拉由配置驱动 | Task 1.1 + 1.2 + 7.2 | schema + ConfigService + 三个 Select |
| issue-create | REQ-1.3 | 目录名与 problem.json 约定 | Task 2.3 | ProblemService.create |
| issue-create | REQ-1.4 | 数据库元数据登记 | Task 2.1 + 2.2 + 2.3 | schema + repository + service |
| **issue-list** | REQ-2.1 | 扫描与目录名解析 | Task 2.4 | OnsiteWatcher + list |
| issue-list | REQ-2.2 | 元数据回填(老目录兼容) | Task 2.3 | ProblemService.list |
| issue-list | REQ-2.3 | 排序与分组 | Task 3.2 | GET /api/onsite/problems |
| issue-list | REQ-2.4 | 实时刷新 | Task 2.4 + 6.2 | chokidar + WS broadcast |
| issue-list | REQ-2.5 | 列表项显示字段 | Task 7.1 | IssueListItem |
| **issue-state** | REQ-3.1 | 四态定义 | Task 3.1 | StateMachine |
| issue-state | REQ-3.2 | 迁移合法性 | Task 3.1 + 3.2 | canTransition + PATCH |
| issue-state | REQ-3.3 | reason 必填(≥8 字符) | Task 3.1 + 3.2 | 审计落库 |
| issue-state | REQ-3.4 | UI 徽章同步(广播) | Task 3.3 + 6.2 + 7.1 | onsite-broadcast + WS + StatusBadge |
| **issue-chat** | REQ-4.1 | cwd 强绑 + 越界拒 | Task 4.1 | OnsiteWebSocketService |
| issue-chat | REQ-4.2 | 切换/新建后 cwd 重定 | Task 4.1 | 切换时 abort |
| issue-chat | REQ-4.3 | Provider 锁为 Claude | Task 6.4 + 7.4 | 路由 + nav |
| issue-chat | REQ-4.4 | 对齐 + 卡片渲染 | Task 7.4 | OnsiteChatStream + CardRenderer |
| **file-upload** | REQ-5.1 | 多文件并行解压(一包一目录) | Task 5.3 + 5.4 | log-unpack + 路由 |
| file-upload | REQ-5.2 | 单包 ≤ 200MB / 总数 ≤ 20 | Task 5.3 + 5.4 | PayloadTooLargeError + 400 |
| file-upload | REQ-5.3 | 解压失败回滚(207) | Task 5.3 | unpacked-<n> 删除回滚 |
| file-upload | REQ-5.4 | 元数据落 onsite_files | Task 2.2 + 5.4 | repository + 路由 |
| **config-read** | REQ-6.1 | 单例 + mtime 监听 | Task 1.2 + 1.3 | ConfigService + watch |
| config-read | REQ-6.2 | schema 校验 + 缺首项拒 | Task 1.1 + 1.2 | JSON schema + ajv |
| config-read | REQ-6.3 | 零硬编码(CI 扫) | Task 7.2 + 8.1 | CustomerSelect + validate-no-hardcoded |
| config-read | REQ-6.4 | API 响应形态 | Task 1.4 | GET /api/onsite/config |
| **no-third-party** | REQ-7.1 | UI 联动(隐藏 chip) | Task 7.2 + 7.3 | NoThirdPartyHint + CwdLockView |
| no-third-party | REQ-7.2 | 服务端跳过切分支 | Task 2.3 + 4.1 | thirdBridgeBranch=null 时不切 |
| no-third-party | REQ-7.3 | 配置变更不破坏既有 | Task 1.3 + 2.3 | problem.json 优先,表不改 |
| **discipline-softening** | REQ-9.1 | 软化词识别 + 标注 | Task 4.2 | middleware |
| discipline-softening | REQ-9.2 | UI 高亮(琥珀波浪) | Task 7.4 | SofteningTag |
| discipline-softening | REQ-9.3 | 阻断已证实(422) | Task 4.3 | confirm-root-cause 校验 |
| discipline-softening | REQ-9.4 | 审计 + 计数 | Task 2.2 + 4.2 + 7.4 | repository + log + DisciplineCounter |
| **discipline-trace-id** | REQ-8.1 | 工具输出监听(强信号) | Task 4.4.a | grep/rg/ag/ack + 0 命中 |
| discipline-trace-id | REQ-8.2 | 自动迁移 blocked | Task 4.4.a | StateMachine.apply |
| discipline-trace-id | REQ-8.3 | 自动 reason 模板 | Task 4.4.a | reason 含 traceId+cmd+time+CLAUDE.md |
| discipline-trace-id | REQ-8.4 | 手动重跑解锁 | Task 7.4 | BlockedCard 按钮 |
| discipline-trace-id | REQ-8.5 | 多信号检测(主+强+弱) | Task 4.4.a + 4.4.b | AI 文本 + grep + suspect |
| discipline-trace-id | REQ-8.6 | envelope discipline flag | Task 4.4.a + 7.4 | 替代 XML 标签 |
| discipline-trace-id | REQ-8.7 | chat 路径隔离 | Task 4.4.a | enabledFor(ws) 检查 |
| **discipline-write-protection** | REQ-10.1 | 中间件挂载 + 隔离 | Task 4.5 | chat 路径不挂 |
| discipline-write-protection | REQ-10.2 | 双正则匹配 | Task 4.5 | 写动作 + 原始路径 |
| discipline-write-protection | REQ-10.3 | 落库 + flag(不 blocked) | Task 4.5 | log + envelope flag |
| discipline-write-protection | REQ-10.4 | system prompt 软约束 | Task 4.5 | 「HARD RULE」置顶注入 |
| discipline-write-protection | REQ-10.5 | UI 计数 + 列表 | Task 4.5 + 7.4 | DisciplineCounter 扩展 |
| **issue-create(增量)** | REQ-1.5 | 问题日期字段 | Task 9.1 | date picker |
| issue-create(增量) | REQ-1.6 | Modal 副标题 | Task 9.2 | 「三项必给信息…」 |
| issue-create(增量) | REQ-1.7 | dz-note 琥珀提示 | Task 9.2 | 「每个压缩包将解压到独立子目录…」 |
| issue-create(增量) | REQ-1.8 | 客户下拉 label 后缀规则 | Task 9.3 | 中石化 → 中石化（sinopec） |
| issue-create(增量) | REQ-1.9 | 客户首项联动隐藏 third-bridge chip | Task 9.4 | AnalysisInfoChips 条件渲染 |
| issue-create(增量) | REQ-1.10 | 数据库下拉「其他」项 | Task 9.5 | value=other 服务端映射 null |
| issue-create(增量) | REQ-1.11 | Modal ESC + 遮罩关闭 | Task 9.6 | onKeyDown + backdrop click |
| issue-create(增量) | REQ-1.12 | 问题主标题字段(title) | Task 9.5 | ProblemRecord.title?: string |
| issue-create(增量) | REQ-1.13 | 新建+上传一气呵成 | Task 9.7 | LogUploader 始终可见 |
| **issue-list(增量)** | REQ-2.6 | 业务阶段分组(进行中/已归档) | Task 9.8 | 5 状态 → 2 业务阶段 |
| issue-list(增量) | REQ-2.7 | 全宽「新建现场问题」按钮 | Task 9.8 | btn-new full width |
| **issue-chat(增量)** | REQ-4.5 | 消息头像 | Task 9.9 | avatar user / ai |
| issue-chat(增量) | REQ-4.6 | msg-role 行 | Task 9.9 | 现场反馈 / Claude · 取证顺序 |
| issue-chat(增量) | REQ-4.7 | composer 底部 hint(cwd) | Task 9.9 | composer-hint |
| issue-chat(增量) | REQ-4.8 | composer placeholder 工作流化 | Task 9.10 | 「补充信息、粘贴日志片段…」 |
| issue-chat(增量) | REQ-4.9 | 空对话流不显示技术化文案 | Task 9.10 | 移除 No messages yet |
| issue-chat(增量) | REQ-4.10 | 证据卡片三色高亮(hl/err/ok) | Task 9.11 | HL_HIT + OK_HIT 正则 |
| **closure-gate(增量)** | (本变更新增门禁类别) | prototype diff 脚本 | Task 10.1 | scripts/diff-onsite-ui-vs-prototype.sh |
| closure-gate(增量) | (本变更新增门禁类别) | CI step | Task 10.2 | .github/workflows/*.yml |
| closure-gate(增量) | (本变更新增门禁类别) | release-archivist 必跑 | Task 10.3 | docs/release-archivist-checklist.md |
| closure-gate(增量) | (本变更新增门禁类别) | code-reviewer prototype 对照 | Task 10.4 | docs/code-reviewer-checklist.md |

**反向索引(每个 Task 实现了哪几条 REQ)**:

| Task | 实现的 REQ | 备注 |
|---|---|---|
| Task 1.1 | config-read REQ-6.2 | JSON schema 落盘 |
| Task 1.2 | config-read REQ-6.1 + 6.2 | ConfigService 骨架 |
| Task 1.3 | config-read REQ-6.1 + no-third-party REQ-7.3 | mtime 监听 + 热加载 |
| Task 1.4 | config-read REQ-6.4 | 暴露 API |
| Task 2.1 | issue-create REQ-1.4 | schema 增量 + migration |
| Task 2.1.b | (本变更新增,无对应 spec) | 事务回滚 + verifyMigrations |
| Task 2.2 | issue-create REQ-1.4 / file-upload REQ-5.4 / discipline-softening REQ-9.4 | 4 个 repository CRUD |
| Task 2.3 | issue-create REQ-1.3 + 1.4 / issue-list REQ-2.2 / no-third-party REQ-7.2 + 7.3 | ProblemService + cwd 越界 |
| Task 2.4 | issue-list REQ-2.1 + 2.4 | OnsiteWatcher chokidar |
| Task 3.1 | issue-state REQ-3.1 + 3.2 + 3.3 | StateMachine 纯函数 |
| Task 3.2 | issue-state REQ-3.2 + 3.3 / issue-list REQ-2.3 | REST 路由 |
| Task 3.3 | issue-state REQ-3.4 | 状态变更广播 |
| Task 4.1 | issue-chat REQ-4.1 + 4.2 / no-third-party REQ-7.2 | OnsiteWebSocket |
| Task 4.2 | discipline-softening REQ-9.1 + 9.4 | 软化词扫描中间件 |
| Task 4.3 | discipline-softening REQ-9.3 | confirm-root-cause 阻断 |
| Task 4.4.a | discipline-trace-id REQ-8.1 + 8.2 + 8.3 + 8.5 + 8.6 + 8.7 | 多信号(主+强) |
| Task 4.4.b | discipline-trace-id REQ-8.5 | 弱信号 suspect |
| Task 4.4.c | discipline-trace-id REQ-8.6 | 前端 suspect toast |
| Task 4.5 | discipline-write-protection REQ-10.1~10.5 | 写原日志软层 |
| Task 5.1 | (技术能力,无 spec REQ 对应;但支撑 discipline-write-protection 硬层) | disallowedTools 7 类 glob |
| Task 5.2 | (server 挂载) | 路由 + WS 收口 |
| Task 5.3 | file-upload REQ-5.1 + 5.2 + 5.3 | log-unpack |
| Task 5.4 | file-upload REQ-5.1 + 5.2 + 5.4 | 上传路由 |
| Task 5.5 | (chat 回归门禁) | 与 Batch 0 配套,无 spec |
| Task 6.1 | (前端 store) | 共享类型 + zustand |
| Task 6.2 | issue-list REQ-2.4 / issue-state REQ-3.4 | OnsiteWebSocketContext |
| Task 6.3 | (i18n) | zh-CN + en 双语 |
| Task 6.4 | issue-chat REQ-4.3 | 路由注册 + sidebar |
| Task 7.1 | issue-list REQ-2.5 / issue-state REQ-3.4 | OnsiteLayout + sidebar |
| Task 7.2 | issue-create REQ-1.1 + 1.2 / config-read REQ-6.3 / no-third-party REQ-7.1 | NewIssueWizard + 3 Select + Uploader |
| Task 7.3 | no-third-party REQ-7.1 | CwdLockView |
| Task 7.4 | issue-chat REQ-4.3 + 4.4 / discipline-softening REQ-9.2 + 9.4 / discipline-trace-id REQ-8.4 + 8.6 / discipline-write-protection REQ-10.5 | OnsiteChatStream + 5 卡片 + softening + counter |
| Task 8.1 | config-read REQ-6.3 | CI 静态扫描 |
| Task 8.2 | (端到端 demo) | demo 脚本 |
| Task 8.3 | (文档) | readme |
| Task 8.4 | (人工验收) | 10 条 Success Criteria |
| Task 9.1 | issue-create(增量) REQ-1.5 | date picker + ProblemService 接 date |
| Task 9.2 | issue-create(增量) REQ-1.6 + 1.7 | 副标题 + dz-note |
| Task 9.3 | issue-create(增量) REQ-1.8 | 客户下拉 label 后缀规则 |
| Task 9.4 | issue-create(增量) REQ-1.9 | 客户首项联动隐藏 chip |
| Task 9.5 | issue-create(增量) REQ-1.10 + 1.12 | 数据库 other + title 字段 |
| Task 9.6 | issue-create(增量) REQ-1.11 | ESC + 遮罩关闭 |
| Task 9.7 | issue-create(增量) REQ-1.13 | 一气呵成(不两阶段) |
| Task 9.8 | issue-list(增量) REQ-2.6 + 2.7 | 业务阶段分组 + 全宽按钮 |
| Task 9.9 | issue-chat(增量) REQ-4.5 + 4.6 + 4.7 | 头像 + msg-role + composer hint |
| Task 9.10 | issue-chat(增量) REQ-4.8 + 4.9 | placeholder + 空对话 |
| Task 9.11 | issue-chat(增量) REQ-4.10 | 证据三色高亮 |
| Task 9.12 | (i18n 收口) | 把 Batch 9 硬编码迁到 i18n |
| Task 10.1 | closure-gate REQ-batch10 | prototype diff 脚本 |
| Task 10.2 | closure-gate | CI step |
| Task 10.3 | closure-gate | release-archivist 必跑 |
| Task 10.4 | closure-gate | code-reviewer 对照 |

---

## Interfaces

> 跨 Batch 依赖的显式契约。

### Batch 1 → Batch 2
- **Produces**: `config.customer-analysis.json`(文件系统),`ConfigService.loaded: ConfigPayload` 单例
- **Consumed by**: `Batch 2` 的 `ProblemService` 在新建时校验客户/迭代 label 是否在配置中

### Batch 2 → Batch 3
- **Produces**: `ProblemService.create(dto): Promise<ProblemRecord>`;`ProblemService.findById(id): Promise<ProblemRecord>`;`ProblemService.list(): Promise<ProblemListItem[]>`
- **Consumed by**: `Batch 3` 的 routes / `Batch 4` 的 middleware / `Batch 5` 的前端 store

### Batch 3 → Batch 4
- **Produces**: `StateMachine.canTransition(from, to): Result<true, { allowed: string[] }>`;`StateMachine.apply(problemId, to, reason, actorId): Promise<void>`
- **Consumed by**: `Batch 4` 的 routes PATCH 端点;`Batch 6` 的两个纪律中间件

### Batch 4 → Batch 5
- **Produces**: WebSocket 协议 envelope `{ kind: 'onsite', type: '...' , payload }`;`OnsiteWsClient.subscribe(cb)` 公开 API
- **Consumed by**: `Batch 5` 的 `OnsiteWebSocketContext` + zustand store

### Batch 5 → Batch 6
- **Produces**: 前端组件 `<OnsiteChatStream />`、`<NewIssueWizard />` 完成
- **Consumed by**: `Batch 7` 的端到端 + CI 静态扫描

### Batch 6 → Batch 7
- **Produces**: 9 个 spec 全部有自动化测试覆盖
- **Consumed by**: `Batch 7` 的端到端 demo + release-archivist 归档

---

## Batch 0:chat 路径回归基线(本变更前置,影响所有 Batch)

> **Why**:本变更不修改 Claude SDK / `chat-websocket.service.ts` 的核心行为,但确实会改 `sessions` 表 schema、`chat-run-registry` 的查询条件、并在 `OnsiteWebSocketService` 里动 spawn options 注入逻辑。**任何一个手抖都可能让 chat 行为退化**。Batch 0 在动手前建立 chat 路径的回归基线,后续每个 PR 都要跑这个基线作对比。
> **依赖**:无。
> **必须在 Batch 1 之前 commit,否则后续所有 PR 缺回归门禁**。

### Task 0.1 — chat 路径回归基线脚本 + CI step(防 C-3)

> **Pre-flight note**:项目用 `node:test`(内置 Node 测试运行器),没有 `pnpm test` 脚本。chat 路径相关测试散落在 `server/modules/websocket/tests/chat-run-registry.test.ts` 等位置,`server/claude-sdk.js` 没有直接的单元测试。

- **Create** `scripts/regression-chat.sh`:
  - 跑 `node --test "server/modules/websocket/tests/*.test.ts" "server/shared/tests/*.test.ts" server/claude-sdk-path.test.*` 等所有 chat/SDK 相关测试
  - **全跑**:`node --test "server/**/*.test.{ts,js}" server/*.test.{ts,js}` 兜底(后端任何测试失败都视为 chat 路径退化,因为 onsite 与 chat 共享 sessions 表 + websocket 通道)
  - 输出 `chat-regression-baseline.txt`,内容含:`<commit_sha> <ISO_date> <pass_count> <fail_count> <elapsed_ms>`,作为后续 PR 对比的 ground truth
  - exit code = 0 当且仅当全部 pass
  - 必须从仓库根目录跑(否则 globs 失效)
- **Create/Modify** `.github/workflows/regression.yml`(新建,因为现有 workflows 都是 desktop/release/docker,无 test workflow):
  - 在 PR 流水线加 step:`./scripts/regression-chat.sh`
  - step 失败 → 阻塞 merge,提示"chat 路径回归失败,请贴 PR 描述里的 baseline 对比"
  - step 成功 → 上传 `chat-regression-baseline.txt` 作为 PR artifact
- **Acceptance**:本 PR 触发 → step 跑通 → `chat-regression-baseline.txt` 落盘;后续 PR 跑该脚本作为前置门禁
- **TDD**:对脚本本身写一个 dry-run 测试(`./scripts/regression-chat.sh --dry-run` 应输出 baseline 格式但**不**跑测试)
- **Commit**:`test(onsite): add chat path regression baseline script + CI gate`

### Task 0.2 — chat 路径影响 diff 工具

- **Create** `scripts/diff-chat-impact.sh`:
  - 对比 `BASE_SHA..HEAD_SHA` 的 `server/claude-sdk.js` + `server/modules/websocket/services/chat-run-registry.service.ts` + `server/modules/websocket/services/chat-websocket.service.ts` + `server/modules/database/repositories/sessions*.ts` 变更
  - 若任一文件有非空 diff → exit 1 + 输出"⚠️ chat 路径有改动,需在 PR 描述里贴 chat-regression-baseline.txt 对比结果"
  - 同时输出"哪些文件被改 + 改了多少行",方便 reviewer 评估
- **Modify** `.github/workflows/*.yml`:在 `regression-chat.sh` 之前加 `diff-chat-impact.sh` 步骤
- **测试**:
  - 故意改 `chat-websocket.service.ts` 一行(无功能影响) → 跑脚本应 exit 1
  - 恢复 → 跑应 exit 0
- **TDD** + **Commit**:`ci(onsite): chat impact diff + regression gate`

---

## Batch 1:配置基础设施(可独立验收,后端零依赖)

> **目标**:把 `config/customer-analysis.json` 从零做到运行时可读、可校验、可热加载,完全无任何业务模块依赖。
> **依赖**:无。

### Task 1.1 — 创建配置文件与 schema

- **Create** `config/customer-analysis.json` — 内容已就位(13 customers + 2 iterations),首项 `branch: null`
- **Create** `config/discipline-words.json` — 软化词中英文 15 个左右
- **Create** `config/json-schemas/customer-analysis.schema.json` — JSON schema;首项 branch 必须 null;iterations 必须匹配 `^(release|master)_...`
- **Test 写**:无(纯配置文件)
- **Acceptance**:`cat config/customer-analysis.json | jq .` 成功;`ajv validate -s config/json-schemas/customer-analysis.schema.json -d config/customer-analysis.json` 退出码 0

### Task 1.2 — `ConfigService` 最小骨架 + 单例

- **Create** `server/modules/onsite-analysis/config.service.ts`
  - 导出 `loadConfig(path: string): Promise<ConfigPayload>`
  - 导出 `getConfig(): ConfigPayload`(单例)
  - 内部用 `ajv` + schema 校验;失败抛 `InvalidConfigError`
  - Type:
    ```ts
    type ConfigCustomer = { label: string; branch: string | null };
    type ConfigPayload = {
      status: 'OK' | 'INVALID';
      mtime: string;
      data: { customers: ConfigCustomer[]; iterations: string[] };
      error?: string;
    };
    ```
- **Test 写** `server/modules/onsite-analysis/tests/config.service.test.ts`:
  ```ts
  test('loadConfig 解析正确配置的 13+2', async () => {
    const c = await loadConfig('config/customer-analysis.json');
    expect(c.status).toBe('OK');
    expect(c.data.customers).toHaveLength(13);
    expect(c.data.iterations).toHaveLength(2);
    expect(c.data.customers[0].branch).toBeNull();
  });
  test('loadConfig 缺首项 branch=null 报 INVALID', async () => {
    await expect(loadConfig('tests/fixtures/bad-first-not-null.json'))
      .rejects.toThrow(/customers\[0\]\.branch must be null/);
  });
  ```
- **跑测试** → 失败(`loadConfig` 还不存在)
- **实现**:写最小函数;**跑测试** → 通过
- **Commit**:`feat(onsite): add config schema and ConfigService skeleton`

### Task 1.3 — mtime 监听与热加载

- **Modify** `server/modules/onsite-analysis/config.service.ts`:
  - 加 `watchConfig(path: string): fs.FSWatcher`,挂 `change` 事件
  - 加 `onConfigChange(cb: (cfg: ConfigPayload) => void): () => void`(订阅,返回 unsubscribe)
- **Test 写**:
  ```ts
  test('mtime 变化触发回调且单例被替换', async () => {
    const cb = vi.fn();
    const off = onConfigChange(cb);
    fs.writeFileSync(tmp, JSON.stringify({ customers: [{label:'x', branch:null}], iterations:['master_5.2_3.2'] }));
    await waitFor(() => cb.mock.calls.length > 0);
    expect(getConfig().data.customers[0].label).toBe('x');
    off();
  });
  ```
- **TDD**:先写测试,确认它失败(因为 watchConfig 还没实现),再实现,再通过
- **Commit**:`feat(onsite): ConfigService mtime watch and hot-reload`

### Task 1.4 — 暴露 HTTP API

- **Create** `server/modules/onsite-analysis/onsite.routes.ts`(暂时只装 config 端点)
  - `GET /api/onsite/config` → 返回 `getConfig()`,附 `Cache-Control: no-store`
  - 用现有 `authenticateToken` 中间件(从 `server/middleware/auth.js` 引用)
- **Modify** `server/index.js:212` 之后新增一行:
  ```js
  app.use('/api/onsite', authenticateToken, onsiteRoutes);
  ```
- **Test 写** `tests/config.route.test.ts`:`supertest` 启动 express mini app;GET 返回 `{ status: 'OK', data: {...} }`
- **TDD** + **Commit**:`feat(onsite): GET /api/onsite/config route`

---

## Batch 2:问题目录与数据模型(后端基础)

> **目标**:数据库 schema、迁移、`ProblemService` 写盘/读盘/列表全部就绪。
> **依赖**:Batch 1(需要 schema 来约束 ProblemService 写 problem.json 时不写非法字段)。

### Task 2.1 — DB schema 增量:5 张新表 + sessions 表加列

- **Modify** `server/modules/database/schema.ts:100-117`(`sessions` 表 CREATE):
  - 加 `kind TEXT NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat','onsite'))`
  - 加 `cwd TEXT`(onsite 才填)
  - 加 `third_bridge_branch TEXT`(onsite 才填)
  - 加 `iteration TEXT`
  - 加 `database TEXT`
  - 加索引 `idx_sessions_kind_cwd ON sessions(kind, cwd)`
- **Modify** `server/modules/database/schema.ts` — 新增以下 SQL 常量:
  - `ONSITE_PROBLEMS_TABLE_SCHEMA_SQL`(5 张表:problems / files / state_audit / discipline_log / problem_index)
  - 每个常量一个 CREATE TABLE,带 IF NOT EXISTS,主键 + 外键
- **Modify** `server/modules/database/migrations.ts:在 LAST_SCANNED_AT_SQL 之前` — 新增:
  - `addSessionsKindAndOnsiteColumns(db)` 函数:用 `PRAGMA table_info` 检查列,缺就 `ALTER TABLE ADD COLUMN`
  - `db.exec(ONSITE_PROBLEMS_TABLE_SCHEMA_SQL)` 五次
  - 各表索引 8 个
- **Test 写** `server/modules/database/tests/onsite-migration.test.ts`:
  ```ts
  test('迁移后 sessions 含 kind 列且默认 chat', () => {
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as any[];
    expect(cols.find(c => c.name === 'kind')).toBeDefined();
  });
  test('5 张新表全部存在', () => {
    for (const t of ['onsite_problems','onsite_files','onsite_state_audit','onsite_discipline_log']) {
      expect(tableExists(t)).toBe(true);
    }
  });
  ```
- **TDD** + **Commit**:`feat(onsite): DB schema + migration for 5 onsite tables and sessions.kind`

### Task 2.1.b — migration 事务包裹 + 启动时 schema 健康检查(防 C-4)

> **Why**:SQLite 的单条 `ALTER TABLE` / `CREATE TABLE` 自动提交,但**整个 `migrations.ts` 的执行不是原子的**——如果第 3 张表创建失败,前 2 张已落盘、`sessions` 表的 ALTER 已落盘,系统进入不一致状态,启动时 `PRAGMA table_info(sessions)` 可能读到半成品 schema。

- **Modify** `server/modules/database/migrations.ts`:
  - 整个迁移流程用 `db.transaction(() => { ... })()` 包裹(SQLite SAVEPOINT 嵌套事务,失败整体回滚)
  - 加 `migrations` 元表 `migrations_applied(id INTEGER PRIMARY KEY, name TEXT UNIQUE, sha TEXT NOT NULL, applied_at TEXT NOT NULL)`,每次执行前先写元数据行
  - 加 `verifyMigrations(db): { ok: true; version: number } | { ok: false; missing: string[]; corrupt: Array<{ name: string; expectedSha: string; actualSha: string }> }`:
    - 启动时跑 `PRAGMA user_version` + `SELECT name, sha FROM migrations_applied ORDER BY id`
    - 任一已记录 migration 的 sha 与当前代码期望不一致 → `corrupt`
    - 代码里有但 DB 没跑 → `missing`
  - 失败抛 `MigrationCorruptionError`,日志打印修复建议("回滚到上一个 good SHA,或清空 DB 后重跑")
  - `server/index.js` 启动流程最前面调用 `verifyMigrations(db)`,失败直接 `process.exit(1)` 不启服务
- **Test 写** `server/modules/database/tests/migration-rollback.test.ts`:
  ```ts
  test('第 3 张表创建失败 → 前 2 张也不存在(事务回滚)', async () => {
    const db = createTempDb();
    const stub = vi.spyOn(db, 'exec').mockImplementationOnce(realExec).mockImplementationOnce(realExec).mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => runMigrations(db)).toThrow();
    expect(tableExists(db, 'onsite_problems')).toBe(false); // 前 2 张也回滚
    expect(tableExists(db, 'onsite_files')).toBe(false);
  });
  test('verifyMigrations 检测 sha 不一致', () => {
    const db = createTempDb();
    runMigrations(db);
    db.prepare("UPDATE migrations_applied SET sha = 'corrupt' WHERE name = '001_onsite_tables'").run();
    const v = verifyMigrations(db);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.corrupt[0].name).toBe('001_onsite_tables');
  });
  ```
- **TDD** + **Commit**:`feat(onsite): migration transaction wrapper + integrity check`

### Task 2.2 — repositories CRUD

- **Create** `server/modules/database/repositories/onsite-problems.db.ts`
  - `insert(p: OnsiteProblemRecord): string`(返回 id)
  - `findById(id: string): OnsiteProblemRecord | null`
  - `findByCwd(cwd: string): OnsiteProblemRecord | null`
  - `list(): OnsiteProblemListItem[]`
  - `updateStatus(id, status, reason, actorId): void`
  - `updateMtime(id, mtime): void`
- **Create** `server/modules/database/repositories/onsite-files.db.ts` — 3 个 CRUD
- **Create** `server/modules/database/repositories/onsite-state-audit.db.ts` — append + list
- **Create** `server/modules/database/repositories/onsite-discipline-log.db.ts` — append + countByProblemId
- **Test 写**:每个 repository 一组 happy-path + boundary 测试
- **TDD**(每个文件单独) + **Commit**:`feat(onsite): 4 onsite repositories with CRUD tests`

### Task 2.3 — `ProblemService` 写盘与 cwd 越界防护

- **Create** `server/modules/onsite-analysis/problem.service.ts`:
  - `ONSITE_ROOT = path.join(os.homedir(), 'work/customer-onsite-analysis')`
  - `assertCwdUnderRoot(cwd: string): void` — 越界抛 `CwdEscapeError`(在 routes 转 403)
  - `create(dto): Promise<ProblemRecord>` — mkdir + write problem.json + INSERT 表,失败回滚
  - `list(): Promise<ProblemListItem[]>` — 扫目录 + 读 problem.json 或 fallback
  - `getById(id): Promise<ProblemRecord | null>`
  - `sanitizeCustomerLabel(s: string): string` — 替换 `/\\:*?"<>|` 为 `_`
- **Test 写**:
  ```ts
  test('create 写入 YYYYMMDD-客户 目录 + problem.json', async () => { ... });
  test('create 同日同客户重复 → 20260703-山西公安_2', async () => { ... });
  test('create cwd=/etc 越界 → 抛 CwdEscapeError', async () => { ... });
  test('list 跳过 docs/ 与 README.md', async () => { ... });
  test('list 兼容无 problem.json 的旧目录 → 默认 pending_info', async () => { ... });
  ```
- **TDD** + **Commit**:`feat(onsite): ProblemService with cwd guard and listing`

### Task 2.4 — `OnsiteWatcher` chokidar 监听

- **Create** `server/modules/onsite-analysis/onsiteWatcher.ts`:
  - 启动时初始化 chokidar 监听 `ONSITE_ROOT`
  - `add` / `unlink` / `change` 事件 debounce 1 秒后调 `list()` 并 emit `problems:changed` 事件
  - 接受 `onChange(cb): () => void`
- **Test 写**:用 `chokidar` 真实文件系统事件;`fs.mkdir` + `fs.writeFile` 触发,验证回调被调
- **TDD** + **Commit**:`feat(onsite): chokidar onsite watcher with 1s debounce`

---

## Batch 3:状态机 + 路由

> **目标**:`StateMachine` 与所有 REST 路由就绪;curl 即可验证。
> **依赖**:Batch 2(`ProblemService`)。

### Task 3.1 — `StateMachine` 纯函数

- **Create** `server/modules/onsite-analysis/state-machine.service.ts`:
  ```ts
  const ALLOWED: Record<Status, Status[]> = {
    pending_info: ['analyzing'],
    analyzing:    ['blocked','confirmed','pending_info'],
    blocked:      ['analyzing'],
    confirmed:    ['analyzing'],
    abandoned:    [],
  };
  function canTransition(from: Status, to: Status): { ok: true } | { ok: false; allowed: Status[] } { ... }
  ```
- **Test 写** `state-machine.test.ts`:
  ```ts
  test.each(ALLOWED_LEGAL)( '%s -> %s 合法', (a, b) => expect(canTransition(a,b).ok).toBe(true) );
  test.each(ALLOWED_ILLEGAL)( '%s -> %s 非法,返回 allowed', (a, b) => { ... });
  test('apply reason < 8 字符抛错', () => { ... });
  ```
- **TDD** + **Commit**:`feat(onsite): state machine with table-driven transitions`

### Task 3.2 — REST 路由:GET/POST/PATCH

- **Modify** `server/modules/onsite-analysis/onsite.routes.ts`:
  - `GET /api/onsite/problems` → `ProblemService.list()` + 按状态分组排序
  - `POST /api/onsite/problems` → 校验三项必给 + customer 必须在配置中(否则 422)+ `ProblemService.create()`(201)
  - `GET /api/onsite/problems/:id` → 200 / 404
  - `PATCH /api/onsite/problems/:id` → `StateMachine.canTransition` + reason >= 8 字符 + 审计;409 / 400
  - `GET /api/onsite/problems/:id/files` → `onsite-files.db.ts` 列表
- **Test 写** `tests/onsite.routes.test.ts`:
  ```ts
  test('POST 缺 customer 返 400'); test('POST customer 不在配置返 422');
  test('POST 成功返 201 且 problem.json 落盘'); test('PATCH 非法状态返 409');
  test('PATCH 缺 reason 返 400'); test('PATCH 合法 transition 返 200 + 审计行');
  test('GET list 按 blocked→analyzing→pending_info→confirmed 排序');
  ```
- **TDD** + **Commit**:`feat(onsite): REST routes for problems + state machine`

### Task 3.3 — 状态变更广播(WS 入口)

- **Create** `server/modules/onsite-analysis/onsite-broadcast.ts`:
  - 内部维护 `subscribers: Set<{ send(msg): void }>`
  - `subscribe(ws)` / `unsubscribe(ws)` / `broadcast(event)`
  - `OnsiteWatcher.onChange` → `broadcast({ type: 'problems:changed' })`
  - 状态 PATCH 成功 → `broadcast({ type: 'problem:<id>:state-changed', payload: { status, reason, at } })`
- **Test 写**:
  ```ts
  test('subscribe 后 broadcast 收到事件', () => { ... });
  test('unsubscribe 后不再收到', () => { ... });
  ```
- **TDD** + **Commit**:`feat(onsite): onsite state broadcast channel`

---

## Batch 4:WebSocket 集成 + 纪律中间件

> **目标**:Claude 跑在 onsite 路径下时,自动套上纪律护栏(软化词扫描、traceId 0 命中切 blocked)。
> **依赖**:Batch 2(`ProblemService.getByCwd`)、Batch 3(`StateMachine.apply`)。

### Task 4.1 — `OnsiteWebSocketService` 消息分发

- **Create** `server/modules/websocket/services/onsite-websocket.service.ts`:
  - 注册路径 `/onsite/ws`
  - 首帧 `{ kind: 'onsite', problemId, cwd, userId }` 验证;验证失败 ws.close 4001
  - 验证通过 → 把 `cwd` 注入 `chat-websocket.service.ts` 的 spawn options,然后正常透传
- **Modify** `server/modules/websocket/services/chat-run-registry.service.ts:50-80`:
  - `register(...)` 与 `abort(...)` 增加 `kind` 参数;`map` 从 `appSessionId → run` 改为 `appSessionId → run & { kind }`
  - 不改变 chat 路径行为(chat 调用处不传 kind,默认为 'chat')
- **Test 写**:
  ```ts
  test('首帧 kind 缺失 ws.close 4001', () => { ... });
  test('kind=onsite 验证后写入 run registry', () => { ... });
  test('cwd 越界 拒绝 spawn', () => { ... });
  ```
- **TDD** + **Commit**:`feat(onsite): OnsiteWebSocketService with kind-aware routing`

### Task 4.2 — 软化词扫描中间件

- **Create** `server/modules/onsite-analysis/discipline/discipline-softening.middleware.ts`:
  - `attachToWs(ws: WsClient): void` — 拦截 `ws.send({ type: 'chat_message', payload: { role: 'assistant', content: '...' } })`
  - 扫描 content 字符串,把每个软化词替换为 `<softening word="X" position="N"/>原词`
  - 命中 → INSERT `onsite_discipline_log`
  - **不修改** chat 路径(检查 `ws.kind === 'onsite'`)
- **Test 写**:
  ```ts
  test('中文「可能」被标注', () => { expect(replace('可能')).toContain('<softening word="可能"') });
  test('英文 might 被标注', () => { ... });
  test('非 onsite 路径不动', () => { ... });
  test('命中写日志', () => { ... });
  ```
- **TDD** + **Commit**:`feat(onsite): discipline-softening middleware`

### Task 4.3 — `discipline-softening` 阻断已证实

- **Modify** `server/modules/onsite-analysis/discipline/discipline-softening.middleware.ts`:
  - 暴露 `containsSoftening(text: string): boolean` 与 `findWords(text): string[]`
  - 在 `onsite.routes.ts` 的「确认为已证实」端点(新增 `POST /api/onsite/problems/:id/confirm-root-cause`)中调用,若含软化词返 422 + `error: 'softening_words_present'`
- **Test 写**:
  ```ts
  test('POST confirm 含「可能」返 422 + words 列表', async () => { ... });
  test('POST confirm 无软化词返 200', async () => { ... });
  ```
- **TDD** + **Commit**:`feat(onsite): confirm-root-cause blocks on softening words`

### Task 4.4 — traceId 检测中间件(防 C-1:多信号融合)

> **Why**:原设计的"grep 命令前缀匹配"启发式脆弱,详见 `design.md §D-9`。本 Task 拆成两段:主信号(AI 文本扫描)+ 弱信号(suspect,非自动 block)。

#### Task 4.4.a — 主信号 + 强信号(自动 blocked)

- **Create** `server/modules/onsite-analysis/discipline/discipline-trace-id.middleware.ts`:
  - 同 4.2 的 attachToWs 模式
  - **主信号**(AI 文本扫描):监听 `assistant` 消息 body,正则匹配 `/未找到|0\s*结果|no matches|found nothing|无命中|没有结果/i`;命中 → emit `discipline:trace-id-empty`
  - **强信号**(工具命令):监听 `tool_result`,正则匹配 `command` 字段形如 `(grep|rg|ag|ack) ... '<traceId>'` + stdout 全 0 → emit
  - emit 后调 `StateMachine.apply(problemId, 'blocked', autoReason, systemActorId)`
  - `autoReason` 包含:`traceId + 触发源(assistant 文本 / 工具命令 + cmd)+ 时间 + CLAUDE.md 引用`
  - **assistant 消息 envelope 增强**:在原消息体旁加 `discipline: { traceIdEmpty: true, matchedText: '未找到' }` 字段,前端按 flag 渲染徽章
- **Test 写**:
  ```ts
  // 主信号
  test('AI 文本含"未找到" → emit + flag traceIdEmpty=true', ...);
  test('AI 文本含"0 结果" → emit', ...);
  test('AI 文本含"no matches" → emit(英文)', ...);
  test('AI 文本含"未找到"但非 traceId 上下文 → 不 emit', ...); // 防误报:必须配合 grep/rg 出现
  
  // 强信号
  test('grep -rc traceX → stdout "0\\n0" 触发 emit', ...);
  test('rg traceX → 0 命中 触发 emit', ...);
  test('ag traceX → 0 命中 触发 emit', ...);
  test('ls 命令不触发', ...);
  
  // 后续行为
  test('emit 后调 StateMachine.apply 切 blocked', ...);
  test('autoReason 包含 traceId + 触发源 + 时间 + CLAUDE.md 引用', ...);
  test('chat 路径不挂载(enabledFor(ws) === false)', ...);
  ```
- **TDD** + **Commit**:`feat(onsite): discipline-trace-id middleware with multi-signal auto-blocked`

#### Task 4.4.b — 弱信号(suspect,非自动 blocked)

- **Modify** `server/modules/onsite-analysis/discipline/discipline-trace-id.middleware.ts`:
  - 加 `detectSuspect(ws, msg)`:监听 `tool_result` 中非 grep-family 的 0 命中(如 `cat a.log` 无内容、`find . -type f | wc -l` 返 0、Python 读文件返空)
  - 命中 → 落 `onsite_discipline_log(kind='trace_id_suspect', problem_id, cmd, stdout_preview, at)` + emit `discipline:trace-id-suspect` 事件
  - **不**调 StateMachine.apply(不自动 blocked)
  - **修改**原消息 envelope 加 `discipline: { traceIdSuspect: true }` flag,前端按此渲染琥珀 toast
- **Test 写**:
  ```ts
  test('cat foo.log(空文件)→ 落 suspect 日志 + flag, 不调 StateMachine', ...);
  test('find . -name "*.log" 无结果 → suspect,不 blocked', ...);
  test('python3 -c "open(\'empty\').read()" 返空 → suspect', ...);
  test('suspect 事件不调 StateMachine.apply', ...);
  test('suspect 日志含 cmd + stdout preview(前 200 字)+ at', ...);
  ```
- **TDD** + **Commit**:`feat(onsite): discipline-trace-id suspect signal (non-blocking)`

#### Task 4.4.c — 前端 suspect toast

- **Create** `src/components/onsite-analysis/TraceIdSuspectToast.tsx`:
  - 监听 WS 消息 envelope 的 `discipline.traceIdSuspect` flag
  - 弹琥珀 toast:"⚠️ Claude 跑了 X 个 0 命中操作(非 grep 家族),请人工确认是否需要补日志"
  - 链接到 `onsite_discipline_log` 该问题的 suspect 列表
- **Test 写**:
  ```tsx
  test('收到 traceIdSuspect flag → 弹 toast', ...);
  test('toast 点击 → 跳转到 discipline 日志页', ...);
  ```
- **TDD** + **Commit**:`feat(onsite): suspect toast UI`

### Task 4.5 — write-protection 运行时审计中间件(防 C-2 软层)

> **Why**:Task 5.1 的 `disallowedTools` 硬拦截覆盖 90% 写动作,但 Claude 仍可走 MCP 工具 / `curl` / `awk` 改写 / Python 子进程组合等绕过字符串匹配。`design.md §D-7.2` 要求加**软审计层**,事后看到"Claude 尝试写原始日志",即使拦不住也留下证据。
> **依赖**:Batch 2(`onsite_discipline_log` 表存在)、Batch 4(中间件架构已就位)。

- **Create** `server/modules/onsite-analysis/discipline/discipline-write-protection.middleware.ts`:
  - 同样 `attachToWs(ws)` 模式,挂在 `chat-websocket.service.ts` 的消息出口
  - 监听 `tool_result.message.content[*].input.command` 字段
  - **写动作模式正则**:`/\b(rm|rm\s+-rf|tee|cp\s+-f|mv|cat\s+.*>|sed\s+-i|awk\s+-i|>\s*[^&|])/` 匹配 bash 命令
  - **原始路径模式正则**:`/(?:^|\s|\/|\\)([^\\\/\s]+\.(log|log\.gz|jsonl|tar\.gz|tgz)|problem\.json|unpacked-[\w-]+)(\s|$|\/|\\)/`
  - 两个正则**同时**命中 → 触发
  - 触发动作:
    1. 落 `onsite_discipline_log(kind='write_protection', problem_id, cmd, stdout_preview=前 200 字, at=ISO8601)`
    2. **修改**原 assistant 消息 envelope,加 `discipline: { writeOriginalLog: true, cmd: '...' }` flag(不修改内容,只加 flag)
    3. emit `discipline:write-protection-detected` 事件
  - **不**调 `StateMachine.apply`(不自动 blocked)
  - chat 路径(`enabledFor(ws) === false`)不挂载
- **Modify** `server/modules/websocket/services/onsite-websocket.service.ts`:
  - 在 spawn Claude 之前,在 system prompt 顶部注入"原始日志禁改"规则(放最前,优先于其他指令):
    ```
    [HARD RULE - 现场纪律]
    禁止修改 cwd 下的 *.log / *.log.gz / *.jsonl / unpacked-* / problem.json / *.tar.gz 等文件。
    如需分析,只读不改,产出写到 analysis/ 子目录。
    违反此规则将被审计并提示用户。
    ```
- **Modify** `src/components/onsite-analysis/DisciplineCounter.tsx`:
  - 加 "写原日志" 计数,与软化词计数并列
  - 点击展开日志列表
- **Test 写**:
  ```ts
  // 中间件单元测试
  test('rm foo.log → 触发 + 落日志 + flag', () => { ... });
  test('echo x > foo.log → 触发(写动作模式含 >)', () => { ... });
  test('sed -i s/x/y/ foo.log → 触发', () => { ... });
  test('tee foo.log < /dev/null → 触发', () => { ... });
  test('cat foo.log(只读)→ 不触发(无写动作)', ...);
  test('echo x > notes.md(非原日志路径)→ 不触发', ...);
  test('命中不调 StateMachine.apply', ...);
  test('chat 路径不挂载', ...);
  test('stdout_preview 截前 200 字', ...);
  
  // system prompt 注入测试
  test('spawn Claude 前 system prompt 含「原始日志禁改」', ...);
  test('规则位置在所有其他 prompt 之前(优先级最高)', ...);
  ```
- **TDD** + **Commit**:`feat(onsite): write-protection middleware + system prompt rule`

---

## Batch 5:Claude SDK 路径黑名单 + 服务端路由挂载收口

> **目标**:Claude 写现场原始日志被拒绝(REQ-4.1 / D-7);所有路由在 `server/index.js` 上挂载完整。
> **依赖**:Batch 4。

### Task 5.1 — Onsite 路径黑名单:通过 `disallowedTools` 注入,**不碰 SDK**

- **Create** `server/modules/onsite-analysis/discipline/onsite-path-blacklist.service.ts`:
  - 静态配置 `ONSITE_PROTECTED_GLOBS = ['*.log','*.log.gz','*.jsonl','unpacked-*','problem.json','*.tar.gz','*.tgz']`(原始日志 + 已解压目录 + 元数据 + 压缩包,**从原 4 类扩到 7 类**)
  - `toDisallowPatterns(globs: string[]): string[]` — 把 glob 翻成 SDK `disallowedTools` 接受的 Bash 工具调用模式,**覆盖所有写动作**:
    - `*.log` → `['Bash(rm **/*.log)','Bash(> **/*.log)','Bash(tee **/*.log)','Bash(sed -i **/*.log)','Bash(python*open*.log)','Bash(python*>*.log)','Write(**/*.log)','Edit(**/*.log)']`
    - `*.log.gz` → 同上(全部 `*.log` 替换 `*.log.gz`)
    - `*.jsonl` → 同上(全部 `*.log` 替换 `*.jsonl`)
    - `unpacked-*` → `['Bash(rm **/unpacked-*)','Bash(rm -rf **/unpacked-*)','Bash(> **/unpacked-*/**)','Write(**/unpacked-*/**)','Edit(**/unpacked-*/**)']`
    - `problem.json` → `['Write(**/problem.json)','Edit(**/problem.json)']`(元数据不可改)
    - `*.tar.gz` / `*.tgz` → `['Bash(rm **/*.tar.gz)','Write(**/*.tar.gz)']`(已上传压缩包不可改)
  - 每个 glob 都生成"破坏性 pattern"集合:`rm` / `>` 重定向 / `tee` / `sed -i` / `python open` / `Write` / `Edit`
- **Modify** `server/modules/websocket/services/onsite-websocket.service.ts`(Batch 4 创建的):
  - 在 spawn Claude 之前调 `onsite-path-blacklist.toDisallowPatterns(ONSITE_PROTECTED_GLOBS)`
  - 把生成的 patterns 追加到 `sdkOptions.disallowedTools`(在 `mapCliOptionsToSDK` 之前手动构造 sdkOptions 时注入)
  - **只对 `ws.kind === 'onsite'` 的会话生效**;chat 路径不调这个 service
- **Modify** `server/modules/providers/list/claude/claude.provider.ts`(或 spawn options 注入点):
  - 确保 onsite 路径传过来的 `options.disallowedTools` 被透传到 `queryClaudeSDK`(`mapCliOptionsToSDK` 第 208 行已支持)
- **Test 写**:
  ```ts
  test('toDisallowPatterns("*.log") 含 Bash rm/>/tee/sed-i/python/Write/Edit 模式', () => { ... });
  test('toDisallowPatterns("problem.json") 只含 Write/Edit(防 Claude 改元数据)', () => { ... });
  test('toDisallowPatterns 7 类 glob 全覆盖,无重复 pattern', () => { ... });
  test('Claude 尝试 Write(problem.json) → 拒绝', () => { ... });
  test('Claude 尝试 "echo x > foo.log" → 拒绝(disallowedTools 字符串含 Bash(>)', () => { ... });
  test('toDisallowPatterns("unpacked-*") 覆盖 Write/Edit/Bash rm', () => { ... });
  test('Onsite 路径 spawn 时 disallowedTools 含保护模式', () => { ... });
  test('Chat 路径 spawn 不调 toDisallowPatterns(行为不变)', () => { ... });
  test('Claude 尝试 rm foo.log → 现有 canUseTool 拒绝(回放现有 chat 测试)', () => { ... });
  ```
- **TDD** + **Commit**:`feat(onsite): path blacklist via disallowedTools (no SDK change)`
- **回退测试**:回放所有 chat 路径测试,确认完全无影响

**为什么这样安全**:
- 现有 `canUseTool`(`server/claude-sdk.js:589-594`)已经处理 `isDisallowed` 分支:`return { behavior: 'deny', message: 'Tool disallowed by settings' }`,直接复用,**零 SDK 改动**
- 现有 `mapCliOptionsToSDK` 第 208 行 `sdkOptions.disallowedTools = settings.disallowedTools || []` 已把 disallowedTools 透传
- chat 路径**永不调** `toDisallowPatterns`;它只在 `onsite-websocket.service.ts` 的 spawn options 注入
- 即使黑名单误判(过严),**最多拒绝 Claude 写文件**,不会改 chat 任何工具调用行为

### Task 5.2 — `server/index.js` 完整挂载

- **Modify** `server/index.js`:
  - L212 后新增: `import onsiteRoutes from './modules/onsite-analysis/index.js'`
  - L212 后新增挂载: `app.use('/api/onsite', authenticateToken, onsiteRoutes)`
  - 在 `wss` 构造之后接入 `OnsiteWebSocketService.bind(wss)`(在 `createWebSocketServer` 后追加一行)
  - 在 `initializeSessionsWatcher` 旁边加 `initializeOnsiteWatcher()`
- **Test 写**:完整 `supertest` 集成测试覆盖 GET / POST / PATCH + WS upgrade
- **TDD** + **Commit**:`feat(onsite): wire all routes and WS into server index`

### Task 5.3 — 日志解压服务

- **Create** `server/modules/onsite-analysis/log-unpack.service.ts`:
  - `unpackMany(files: UploadedFile[], destDir: string): Promise<UnpackResult[]>`
  - 用 `unzipper`;每个 zip → `destDir/unpacked-<n>/`
  - 单包超 200MB 抛 `PayloadTooLargeError`;总数 > 20 抛 `TooManyFilesError`
  - 损坏 zip:删除对应 `unpacked-<n>/`(回滚)并返回该项 `{ ok: false, error: '...' }`
- **Test 写**:
  ```ts
  test('3 个 zip 并行 → 3 个 unpacked-N 目录,无覆盖', ...);
  test('250MB zip 抛 PayloadTooLargeError', ...);
  test('第 3 个 zip 损坏 → unpacked-3 不存在 + 207 返回', ...);
  ```
- **TDD** + **Commit**:`feat(onsite): log-unpack service with one-archive-per-dir rule`

### Task 5.4 — 文件上传路由

- **Modify** `server/modules/onsite-analysis/onsite.routes.ts`:
  - 加 `POST /api/onsite/problems/:id/files` — multer 多文件接收,调 `LogUnpackService.unpackMany`,落 `onsite_files` 表
  - 加 `GET /api/onsite/problems/:id/files` — 列表
- **Test 写**:
  ```ts
  test('上传 3 zip 返 200,3 行入库,3 个目录存在', ...);
  test('单包 250MB 返 413', ...);
  test('第 3 包损坏 返 207,2 行入库', ...);
  ```
- **TDD** + **Commit**:`feat(onsite): file upload routes`

### Task 5.5 — chat 路径回归强制门禁(本变更后置,与 Batch 0 配套)

> **Why**:Batch 0~5 期间会改 `sessions` 表 / `chat-run-registry` / `chat-websocket.service` 的 spawn options 注入点。Batch 5 结束时必须再跑一次 chat 回归,与 Batch 0 baseline 对比,任何 chat 行为退化在此刻被捕获。
> **依赖**:Batch 0(`scripts/regression-chat.sh` 必须存在)、Batch 1~4(全部后端代码就位)。
> **不 commit 代码,只验证**:该 Task 的 deliverable 是"chat-regression-baseline.txt 前后对比 + diff 为零(或仅是预期内的 schema 扩展)"。

- **执行** `./scripts/regression-chat.sh` 重新生成 `chat-regression-baseline.txt`
- **执行** `diff <(git show HEAD~N:chat-regression-baseline.txt) <(cat chat-regression-baseline.txt)`(N = 自 Batch 0 以来的 commit 数)
  - 若 pass/fail 数与 baseline 一致 → 通过
  - 若不一致 → 必须修代码直到一致,或在 `docs/onsite-analysis-acceptance.md` 写明"故意改动 + 原因 + 风险评估"
- **执行** `./scripts/diff-chat-impact.sh`:`BASE_SHA = 6a88025(初始化 commit)`,验证 chat 路径文件 diff 为空(允许的例外:`chat-run-registry` 加 `kind` 参数、`sessions` 表加列——这两处必须 e2e 验证)
- **E2E 验证**:
  - 起服务,跑现有 chat e2e(随便开个 chat session 问一句话),确认**与 main 分支行为完全一致**
  - 跑 onsite 新建问题 → 发消息 → Claude 回复,确认 onsite 路径正常
- **Acceptance**:`docs/onsite-analysis-acceptance.md` 加段"chat 路径回归证据",贴 baseline diff + e2e 日志
- **不 commit 代码**(纯验证活动);若发现回归 → 修代码 + 新 commit + 重跑

---

---

## Batch 6:前端基础设施(store + WS + i18n + 路由注册)

> **目标**:前端骨架可渲染;打开 `/onsite` 能看到空侧栏与「新建」按钮。
> **依赖**:Batch 1-5(后端 API)。

### Task 6.1 — 共享类型 + zustand store

- **Create** `shared/onsite-types.ts`:
  ```ts
  export type ProblemStatus = 'pending_info' | 'analyzing' | 'blocked' | 'confirmed' | 'abandoned';
  export interface ProblemRecord { id: string; customer: string; thirdBridgeBranch: string | null; iteration: string; database: string; status: ProblemStatus; cwd: string; createdAt: string; }
  export interface ConfigCustomer { label: string; branch: string | null; }
  export interface ConfigPayload { status: 'OK' | 'INVALID'; mtime: string; data: { customers: ConfigCustomer[]; iterations: string[] }; error?: string; }
  export interface OnsiteFile { id: string; problemId: string; originalName: string; size: number; kind: 'archive' | 'log' | 'image' | 'other'; unpackedDir?: string; uploadedAt: string; }
  ```
- **Create** `src/stores/onsiteStore.ts`:
  - state: `currentProblemId | null`, `problems: ProblemListItem[]`, `config: ConfigPayload | null`, `uploading: { [id]: number }`
  - actions: `loadConfig()`, `loadProblems()`, `selectProblem(id)`, `patchStatus(id, to, reason)`, `uploadFiles(id, files)`
- **TDD**:无(纯 TS 类型 + 简单 reducer);TypeScript 编译通过即过
- **Commit**:`feat(onsite): shared types and zustand store`

### Task 6.2 — WS Context + 自动重连

- **Create** `src/contexts/OnsiteWebSocketContext.tsx`:
  - 单例 `WebSocket('ws://<host>/onsite/ws')`
  - 首帧 `kind: 'onsite', problemId, cwd, userId`
  - 收到 `problems:changed` → `onsiteStore.loadProblems()`
  - 收到 `problem:<id>:state-changed` → 更新 store
  - 自动重连(指数退避,上限 30s)
- **Test 写**:`msw` 拦截 WS,验证重连与消息分发
- **TDD** + **Commit**:`feat(onsite): OnsiteWebSocket context with reconnect`

### Task 6.3 — i18n 命名空间

- **Create** `src/i18n/locales/zh-CN/onsite.json` — 中文键 `nav.onsite`, `wizard.title`, `wizard.customer`, `wizard.iteration`, `wizard.database`, `wizard.upload`, `status.pending_info`, `status.analyzing`, `status.blocked`, `status.confirmed`, `error.configInvalid`, ...
- **Create** `src/i18n/locales/en/onsite.json` — 同样键
- **Modify** `src/i18n/index.ts` — 在 resources 注册 `onsite` ns
- **Test 写**:`expect(t('onsite:wizard.title')).toBeDefined()`
- **Commit**:`feat(onsite): i18n namespace`

### Task 6.4 — 路由注册 + sidebar 入口

- **Modify** `src/App.tsx:90-100`:
  - 加 `<Route path="/onsite" element={<OnsiteLayout />} />`
  - 加 `<Route path="/onsite/:problemId" element={<OnsiteLayout />} />`
- **Modify** `src/components/sidebar/view/Sidebar.tsx:1-90`:
  - 在顶 tab 行加一个按钮:「🔍 客户现场分析」,active 状态匹配 `/onsite/*`
  - onClick → `navigate('/onsite')`
- **Test 写**:
  ```tsx
  test('sidebar 显示「客户现场分析」按钮', () => { ... });
  test('点击 navigate 到 /onsite', () => { ... });
  ```
- **TDD** + **Commit**:`feat(onsite): route + sidebar entry`

---

## Batch 7:前端页面 + 卡片 + 软化词 UI

> **目标**:完整页面可点击,业务流程跑通。
> **依赖**:Batch 6。

### Task 7.1 — `OnsiteLayout` + `IssueListSidebar` + `IssueListItem`

- **Create** `src/components/onsite-analysis/OnsiteLayout.tsx`:
  - 左侧 300px `IssueListSidebar` + 右侧 `Outlet` 渲染当前问题 chat
- **Create** `src/components/onsite-analysis/IssueListSidebar.tsx`:
  - 顶部「+ 新建」按钮
  - 搜索框(本地过滤客户名)
  - 分组渲染: `blocked / analyzing / pending_info / confirmed` 四组(对应 utils)
- **Create** `src/components/onsite-analysis/IssueListItem.tsx`:
  - 客户名 + 状态徽章 + 目录名 + iteration/database chip + mtime 相对时间
- **Create** `src/components/onsite-analysis/StatusBadge.tsx` — 4 状态色按设计
- **Test 写**:`@testing-library/react` 渲染 + 快照 + 交互
- **TDD** + **Commit**:`feat(onsite): issue list sidebar and layout`

### Task 7.2 — `NewIssueWizard` + 三个 Select + LogUploader

- **Create** `src/components/onsite-analysis/NewIssueWizard.tsx` — 模态
- **Create** `src/components/onsite-analysis/CustomerSelect.tsx`:
  - 调 `useOnsiteStore(s => s.config)`,无 fallback(读不到就显示红字「配置加载失败」并 disabled 提交)
  - 纯 `<select>`,**无 input / 无 datalist / 无 typeahead**
- **Create** `src/components/onsite-analysis/IterationSelect.tsx` — 同上
- **Create** `src/components/onsite-analysis/DatabaseSelect.tsx` — 4 个固定选项
- **Create** `src/components/onsite-analysis/LogUploader.tsx`:
  - 拖拽区 + 多文件选择
  - 单包超 200MB 客户端先截掉 + 提示
  - 上传进度条
- **Create** `src/components/onsite-analysis/NoThirdPartyHint.tsx`:
  - 选中首项时显示提示;同时把 `branch` 字段从 wizard 提交体里剔掉
- **Test 写**:
  ```tsx
  test('客户未选 → 提交按钮 disabled', ...);
  test('三项全选 → 提交按钮 enabled', ...);
  test('选「不涉及三方对接」→ branch 字段 null', ...);
  test('上传 21 个文件 → 提交前截到 20 + 提示', ...);
  ```
- **TDD** + **Commit**:`feat(onsite): new issue wizard with three selects`

### Task 7.3 — `CwdLockView` 顶栏锁定

- **Create** `src/components/onsite-analysis/CwdLockView.tsx`:
  - 显示 `🔒 ~/work/customer-onsite-analysis/20260703-山西公安`,只读
  - 路径超长截断中间,hover 显示完整
- **Test 写**:渲染快照
- **Commit**:`feat(onsite): cwd lock view`

### Task 7.4 — `OnsiteChatStream` + 卡片 + 软化词 UI

- **Create** `src/components/onsite-analysis/OnsiteChatStream.tsx`:
  - 拉取 messages(`/api/onsite/problems/:id/messages`)
  - 用户消息用 `.msg.user` 样式(右蓝气泡);AI 用 `.msg.ai`(左平铺)
  - AI 消息用 `CardRenderer` 渲染 `<card type="...">`
  - 顶部显示 `CwdLockView` + `StatusBadge` + `DisciplineCounter`
  - 底部输入框:Enter 发送;`Shift+Enter` 换行
- **Create** `src/components/onsite-analysis/cards/CardRenderer.tsx` — type 分发
- **Create** `src/components/onsite-analysis/cards/EvidenceCard.tsx` — 🔍
- **Create** `src/components/onsite-analysis/cards/BlockedCard.tsx` — ⛔
- **Create** `src/components/onsite-analysis/cards/RootCauseCard.tsx` — ✅
- **Create** `src/components/onsite-analysis/cards/SqlCard.tsx` — 📋
- **Create** `src/components/onsite-analysis/SofteningTag.tsx` — 琥珀波浪下划线
- **Create** `src/components/onsite-analysis/DisciplineCounter.tsx` — `本会话软化词 N 处`
- **Test 写**:
  ```tsx
  test('用户消息右对齐,蓝气泡,头像在右', ...);
  test('AI 消息左对齐,无气泡', ...);
  test('card type=evidence 渲染为 🔍 灰', ...);
  test('card type=blocked 渲染为 ⛔ 琥珀', ...);
  test('card type=root_cause 渲染为 ✅ 绿', ...);
  test('软化词被 SofteningTag 包成琥珀波浪线', ...);
  ```
- **TDD** + **Commit**:`feat(onsite): chat stream with cards and softening tag`

---

## Batch 8:CI 静态扫描 + 端到端 demo + 验收

> **目标**:脚本就绪,演示流程跑通,所有 10 条成功标准可勾。
> **依赖**:Batch 1-7。

### Task 8.1 — CI 静态扫描脚本

- **Create** `scripts/validate-no-hardcoded-customers.sh`:
  - grep `src/components/onsite-analysis/**`: 「手动输入」/「其他」/「请输入客户」/「请输入迭代」/ 已知客户名(sinopec / zgj_565939 / psbc_youchu / zcck / gdjt / sse / ...)
  - 命中即 exit 1
  - 白名单:原型文件 `design-prototypes/**`,测试 fixture
- **Modify** `.github/workflows/*.yml` — PR 流水线加 step:`./scripts/validate-no-hardcoded-customers.sh`
- **Test 写**:
  - 创建临时 `src/components/onsite-analysis/test-skip-input.tsx` 含「手动输入」,运行脚本应 exit 1
  - 删除该文件,运行应 exit 0
- **TDD** + **Commit**:`ci(onsite): validate-no-hardcoded-customers script + workflow step`

### Task 8.2 — 端到端 demo 流程脚本

- **Create** `scripts/demo-onsite.sh`:
  1. 起服务(开发模式)
  2. `curl POST /api/onsite/problems` 创建「中车长客」「zcck」分支的问题
  3. `curl POST /api/onsite/problems/:id/files` 上传 2 个 zip
  4. `curl GET /api/onsite/problems` 验证返回
  5. `curl PATCH ... { status: 'analyzing' }` 切换状态
  6. `curl PATCH ... { status: 'confirmed' }` 验证软化词阻断
  7. 退出
- **Test 写**:在 CI 中跑该脚本(需要先启动服务)
- **Commit**:`test(onsite): end-to-end demo script`

### Task 8.3 — README 与 demo 文档

- **Create** `docs/onsite-analysis.md`:
  - 1 段「是什么」
  - 1 段「快速开始」(`npx ... onsite` 或 UI 入口)
  - 截图占位(待真实 UI 截图替换)
  - 「与终端工作流的关系」段
- **Commit**:`docs(onsite): readme`

### Task 8.4 — 验收 10 条成功标准

逐条人工验证(在 `xy-claudecodeui` 本地):
1. 三项必给信息强制采集 → 进 `/onsite` 点新建
2. 下拉由配置驱动 → 检查 DOM
3. 不允许手动输入 → grep 源码
4. cwd 锁定 → 进问题看顶栏
5. Provider 锁定 → 进 `/onsite` 看 nav
6. 纪律可视化 → 含软化词的 mock 消息送入
7. traceId 0 命中 → 模拟命令
8. 一包一目录 → 上传 2 zip 检查目录
9. 配置热加载 → 改 JSON
10. 零硬编码 → 跑 `validate-no-hardcoded-customers.sh`

无 commit(纯人工验收),把每条结果写入 `docs/onsite-analysis-acceptance.md`。

---

## Prototype field alignment checklist(prototype 字段对齐验收清单)

> **Why**:本变更第二轮增量(2026-07-06)发现,即使功能跑通,UI 与 prototype HTML 仍有 13+ 项字段/交互差距。本清单是 closure 阶段强制过的一道门,**每条都必须勾选并附证据(截图/grep/DOM probe)**。
> 由 `scripts/diff-onsite-ui-vs-prototype.sh`(Batch 10)自动跑出大部分;少数需人工目视。

| # | 条款 | 自动/人工 | 验证方法 |
|---|---|---|---|
| ☐ 1 | REQ-1.5 日期选择器(`<input type=date>`,默认今日) | 自动 | DOM probe + 后端 `problem.json.createdAt` 与日期字段一致 |
| ☐ 2 | REQ-1.6 Modal 副标题(「三项必给信息用于定位服务分支与 SQL 方言…」) | 自动 | DOM probe 文案匹配 |
| ☐ 3 | REQ-1.7 dz-note 琥珀提示(「每个压缩包将解压到独立子目录…禁止覆盖」) | 自动 | DOM probe 文案匹配 + 边框色 amber 校验 |
| ☐ 4 | REQ-1.8 客户下拉 label 自动追加分支后缀(中石化 → 中石化(sinopec)) | 自动 | DOM probe 每个 `<option>` 文本后缀规则 |
| ☐ 5 | REQ-1.9 客户首项「不涉及三方对接」联动隐藏 third-bridge chip | 自动 | 选中首项 + DOM probe 头部无 chip |
| ☐ 6 | REQ-1.10 数据库下拉含「其他」项 | 自动 | DOM probe 末项 `value=other` + 后端映射 null |
| ☐ 7 | REQ-1.11 ESC 与遮罩点击关闭 modal | 自动 | Vitest 模拟 keydown/click,断言 onClose 调用 |
| ☐ 8 | REQ-1.12 问题主标题字段(title) | 自动 | DOM probe + 后端 `problem.json.title` |
| ☐ 9 | REQ-1.13 新建+上传一气呵成(modal 不关) | 自动 | 创建成功后 DOM probe dropzone 仍可见且 enabled |
| ☐ 10 | REQ-4.5 消息头像(我 30×30 / C 30×30) | 自动 | DOM probe 每个 `.msg` 含 `.avatar.user` 或 `.avatar.ai` |
| ☐ 11 | REQ-4.6 msg-role 行(「现场反馈」/「Claude · 取证顺序…」) | 自动 | DOM probe `.msg-role` 文案匹配 |
| ☐ 12 | REQ-4.7 composer 底部 hint(cwd 完整路径) | 自动 | DOM probe `.composer-hint` 含 `cwd` 全路径 |
| ☐ 13 | REQ-4.8 composer placeholder 工作流化文案 | 自动 | DOM probe `textarea[placeholder]` 不含「Enter」「Shift」字样 |
| ☐ 14 | REQ-4.9 空对话流不显示"No messages yet" | 自动 | Vitest 断言空数组时 DOM 不含该文案 |
| ☐ 15 | REQ-4.10 证据卡片 logquote 三色高亮(hl/err/ok) | 自动 | Vitest 渲染 fixture,断言三类 span 数量 |
| ☐ 16 | REQ-2.6 业务阶段分组(进行中 / 已归档) | 自动 | DOM probe 仅有 2 个 `.list-label`,分别含「进行中」「已归档」 |
| ☐ 17 | REQ-2.7 全宽「新建现场问题」按钮 | 自动 | DOM probe 按钮宽度 ≥ 90% 侧栏宽度 + 文本完整 |

**人工目视项**(无法自动化,需 reviewer 在 PR 中贴截图):
- ☐ 18 整体视觉密度与 prototype 接近(截图 + side-by-side)
- ☐ 19 新建流程一气呵成的体感(录屏 / 截图三连:打开 modal → 创建 → 上传)
- ☐ 20 卡片视觉权重(🔍/⛔/✅/📋 四色)与 prototype 一致

未勾选项一律不准 closure。

---

## Batch 9:Prototype 字段对齐(本变更第二轮增量,React 侧)

> **Why**:Batch 7 实施时只对齐了功能契约(REQ-1.1/1.2/4.1/4.4),未逐字段对齐 prototype HTML。本 Batch 把 prototype 里的设计字段全部补齐到 React 实现,与 Batch 1-8 不冲突,**纯前端增量**,不触 chat 路径。
> **依赖**:Batch 7(前端页面骨架必须已存在)。
> **不修改**:`shared/onsite-types.ts` 不变(prototype 字段都是 UI 展示层,不需 schema 变更;只有 title 字段例外——见 Task 9.6)。

### Task 9.1 — NewIssueWizard 加日期选择器(REQ-1.5)

- **Modify** `src/components/onsite-analysis/NewIssueWizard.tsx`
  - 加 `date: string` state,默认值 `new Date().toISOString().slice(0, 10)`
  - 日期字段用 `<input type="date" data-testid="onsite-date-input">`,与 customer select 同 row
  - 提交时把 `date` 作为 `cwd` 目录名的 YYYYMMDD 来源,传给后端(后端 `ProblemService.create` 接 `date` 字段,优先级 > 服务端 `new Date()`)
- **Modify** `server/modules/onsite-analysis/problem.service.ts`
  - `create(dto)` 用 `dto.date ?? new Date().toISOString().slice(0,10).replace(/-/g, '')` 计算 `YYYYMMDD`
  - 加 zod 校验:`date > today` → 抛 `400 「问题日期不能晚于今天」`
- **Test**:
  - 加 `problem.service.test.ts`:「选了未来日期 → 抛 BadRequest」
  - 加 `NewIssueWizard.test.tsx`:「默认日期字段值是今天 ISO 字符串」
- **Acceptance**:提交成功后 `problem.json` 中 `cwd` 目录前缀与所选日期一致
- **Commit**:`feat(onsite): date picker in new issue wizard (REQ-1.5)`

### Task 9.2 — 副标题 + dz-note 琥珀提示(REQ-1.6 / REQ-1.7)

- **Modify** `src/components/onsite-analysis/NewIssueWizard.tsx`
  - modal-head 下加 `<p>` 副标题,文案硬编码或放 i18n `onsite:wizard.subtitle`
  - `LogUploader.tsx` 下方加 `<div class="dz-note">` 琥珀提示,文案同上
- **i18n**:
  - `src/i18n/locales/zh-CN/onsite.json` 加 `wizard.subtitle` / `wizard.dzNote`
  - `src/i18n/locales/en/onsite.json` 同步
- **Test**:NewIssueWizard.test.tsx 加 DOM probe:`getByText(/三项必给信息/)` 不为空
- **Commit**:`feat(onsite): modal subtitle + dz-note amber hint (REQ-1.6/1.7)`

### Task 9.3 — 客户下拉 label 后缀规则(REQ-1.8)

- **Modify** `src/components/onsite-analysis/CustomerSelect.tsx`
  - 在 `<option>{c.label}</option>` 处改写 label:`label.includes('（') || label.includes('(') || label === c.branch ? label : ${label}（${c.branch}）`
  - `branch === null` 时不追加
- **Test**:CustomerSelect 单元测试加 3 个 case(自带括号 / 纯中文 / 首项无后缀)
- **Acceptance**:DOM probe `option[value="sinopec"]` 的文本是「中石化（sinopec）」
- **Commit**:`feat(onsite): customer option branch suffix (REQ-1.8)`

### Task 9.4 — 客户首项联动 third-bridge chip(REQ-1.9)

- **Modify** `src/components/onsite-analysis/AnalysisInfoChips.tsx`
  - 接收新 prop `noThirdBridge: boolean`(从 `problem.third_bridge_branch === null` 计算)
  - 当 `noThirdBridge === true`,不渲染「third-bridge 分支」chip
- **Modify** `src/components/onsite-analysis/OnsiteChatStream.tsx`:把 `problem.third_bridge_branch === null` 传下去
- **Test**:AnalysisInfoChips 单元测试加 case:「branch=null → 不渲染 third-bridge chip」
- **Commit**:`feat(onsite): hide third-bridge chip when no-third-party (REQ-1.9)`

### Task 9.5 — 数据库「其他」项 + title 字段(REQ-1.10 / REQ-1.12)

- **Modify** `src/components/onsite-analysis/DatabaseSelect.tsx`
  - `DATABASE_KINDS` 末尾加 `'other'`(值与枚举并存,前端枚举只有 4 项 + other)
  - 选中 `other` 时,下方显示提示「未指定数据库类型,请稍后在现场补充」
- **Modify** `shared/onsite-types.ts`:`ProblemRecord` 加可选字段 `title?: string`
- **Modify** `server/modules/onsite-analysis/problem.service.ts`:`create(dto)` 接 `title`;若 `database === 'other'`,落库为 `null`
- **Modify** `NewIssueWizard.tsx`:加 `title: string` state + `<input data-testid="onsite-title-input">`;校验长度 ≤ 80,超长置灰提交
- **Modify** `OnsiteChatStream.tsx` 第 282 行:title 渲染规则——`{problem.customer} · {problem.title || '现场问题'}`
- **i18n**:`onsite:wizard.titlePlaceholder` / `onsite:wizard.titleTooLong`
- **Test**:ProblemService / DatabaseSelect / NewIssueWizard 各加 case
- **Commit**:`feat(onsite): database other option + title field (REQ-1.10/1.12)`

### Task 9.6 — Modal ESC + 遮罩关闭(REQ-1.11)

- **Modify** `src/components/onsite-analysis/NewIssueWizard.tsx`
  - 最外层 div 加 `onKeyDown` 监听 ESC → `onClose()`
  - backdrop div 加 `onClick={onClose}`,modal 卡片本身 `onClick={(e) => e.stopPropagation()}`
  - useEffect 里 `document.addEventListener('keydown', ...)` + 卸载时移除
- **Test**:NewIssueWizard.test.tsx 加 2 个 case(ESC 触发 onClose / 点 backdrop 触发 onClose)
- **Commit**:`feat(onsite): modal ESC + backdrop close (REQ-1.11)`

### Task 9.7 — LogUploader 在 modal 内始终可见(REQ-1.13)

- **Modify** `src/components/onsite-analysis/NewIssueWizard.tsx`
  - 移除「`createdId && <LogUploader ... />`」的条件渲染
  - 改成永远渲染 `<LogUploader problemId={createdId} />`,只是当 `problemId === null` 时 `LogUploader` 内部 disabled + 显示提示「请先创建问题再上传文件」
  - 提交按钮在创建成功后置灰(已创建,不能再点)
- **Modify** `src/components/onsite-analysis/LogUploader.tsx`:确认 `problemId === null` 时的 disabled + 提示文案符合 REQ-1.7(已有部分实现,加文案校验)
- **Test**:NewIssueWizard.test.tsx 加 case:「打开时 dropzone 可见 + disabled」/「创建后 dropzone enabled」
- **Commit**:`feat(onsite): one-shot wizard with always-visible dropzone (REQ-1.13)`

### Task 9.8 — IssueListSidebar 业务阶段分组 + 全宽新建按钮(REQ-2.6 / REQ-2.7)

- **Modify** `src/components/onsite-analysis/IssueListSidebar.tsx`
  - 把 `VISIBLE_GROUPS`(5 个状态)改成 2 个业务阶段:`active` (blocked/analyzing/pending_info) + `archived` (confirmed/abandoned)
  - section label 文案改「进行中 · N」/「已归档 · M」
  - 把头部右上角小+号按钮**整段移除**,改成顶部全宽 `<button class="btn-new">➕ 新建现场问题</button>`
- **i18n**:加 `onsite:nav.active` / `onsite:nav.archived`
- **Test**:IssueListSidebar.test.tsx 加 case:「5 个状态混合 → 仅有 2 个 section」/「新建按钮宽度 = 100%」
- **Commit**:`feat(onsite): business-phase grouping + full-width new button (REQ-2.6/2.7)`

### Task 9.9 — MessageBubble 头像 + msg-role + composer hint(REQ-4.5 / REQ-4.6 / REQ-4.7)

- **Modify** `src/components/onsite-analysis/OnsiteChatStream.tsx`
  - `MessageBubble` 组件:用户消息加 `<div className="avatar user">我</div>` 头像(右对齐);AI 消息加 `<div className="avatar ai">C</div>` 头像(左对齐);行反转用 `flex-direction: row-reverse`
  - 每条消息体上方加 `<div className="msg-role">{role === 'user' ? '现场反馈' : `Claude · 取证顺序：日志 → 源码 → DB`}</div>`
  - composer footer 下方加 `<div className="composer-hint">仅对接 Claude Code · 工作目录锁定在 {problem.cwd}</div>`
- **Test**:OnsiteChatStream.test.tsx 加 case:「用户消息含 .avatar.user + 「现场反馈」文本」/「composer 下方含 composer-hint 且含 cwd」
- **Commit**:`feat(onsite): chat message avatar + msg-role + composer hint (REQ-4.5/4.6/4.7)`

### Task 9.10 — Composer placeholder + 空对话(REQ-4.8 / REQ-4.9)

- **Modify** `src/components/onsite-analysis/OnsiteChatStream.tsx`
  - textarea `placeholder` 改硬编码或 i18n 「补充信息、粘贴日志片段,或让 Claude 继续下一步取证…」
  - 移除 `messages.length === 0` 分支里的「No messages yet」提示,改成 `return null`
- **i18n**:加 `onsite:composer.placeholder`
- **Test**:OnsiteChatStream 空数组 → DOM 不含「No messages yet」
- **Commit**:`feat(onsite): composer placeholder + blank empty state (REQ-4.8/4.9)`

### Task 9.11 — EvidenceCard 三色高亮(REQ-4.10)

- **Modify** `src/components/onsite-analysis/cards/EvidenceCard.tsx`
  - 在 `ZERO_HIT` 之外加 `HL_HIT`(琥珀加粗,匹配 `# .*` 注释行 / `命中` 关键字)与 `OK_HIT`(绿色,匹配 `:\s*[1-9]\d*\s*$` 或 `命中 \d+ 条` / `match(es)?: \d+`)
  - `renderLogLine` 返回 3 类 span,各自对应 className
- **Test**:EvidenceCard 测试 fixture 包含三色行各一行,断言 span 数量与 className
- **Commit**:`feat(onsite): evidence card three-color highlight (REQ-4.10)`

### Task 9.12 — i18n 全量对齐 + 视觉回归

- **Modify** `src/i18n/locales/zh-CN/onsite.json` 与 `en/onsite.json`:把 Batch 9 新增的所有硬编码中文文本迁到 i18n 命名空间
- **手动**:对照 prototype HTML 一行一行 review,确认没有遗漏的字段/文案
- **Acceptance**:diff 脚本(Batch 10)输出 `0 missing fields`
- **Commit**:`feat(onsite): i18n extraction for prototype-aligned copy`

---

## Batch 10:Closure Diff 脚本(code-reviewer 与 release-archivist 门禁)

> **Why**:Batch 9 实施完了之后,closure 阶段必须有工具强制校验「UI 实现字段与 prototype 一致」。本 Batch 提供自动化脚本 + 门禁。
> **依赖**:Batch 9 完成(实施侧的字段已经存在,才有意义 diff)。

### Task 10.1 — `scripts/diff-onsite-ui-vs-prototype.sh`

- **Create** `scripts/diff-onsite-ui-vs-prototype.sh`:
  - 输入:`design-prototypes/customer-onsite-analysis/index.html`(prototype) + `src/components/onsite-analysis/**`(实现)
  - 解析 prototype HTML 里的关键字段名/文案/`data-testid`(用 grep + node regex,不必引 cheerio)
  - 对照实现侧的 17 条 checklist(REQ-1.5/1.6/1.7/1.8/1.9/1.10/1.11/1.12/1.13/4.5/4.6/4.7/4.8/4.9/4.10/2.6/2.7)逐条检测:
    - 字段存在性:DOM probe(JSDOM 跑组件 → assert)
    - 文案匹配:`grep -F` 必须命中
    - 行为存在:从源码 grep 关键模式(如 `onKeyDown.*Escape` / `row-reverse` / `composer-hint`)
  - 输出 `prototype-diff-report.md`:
    - 17 条 checklist + PASS/FAIL + 证据(grep 行 / DOM probe 结果)
    - 总分:17 - FAIL_count
  - exit code 0 当且仅当全部 PASS
- **TDD**:脚本本身写一个 dry-run 测试:`./scripts/diff-onsite-ui-vs-prototype.sh --dry-run` 应输出 checklist 模板但**不**跑 DOM probe
- **Acceptance**:脚本跑通后产出 report,FAIL 数为 0
- **Commit**:`ci(onsite): prototype diff script + closure gate (Batch 10)`

### Task 10.2 — `.github/workflows/*.yml` 加 prototype diff step

- **Modify** `.github/workflows/*.yml`
  - PR 流水线在 `validate-no-hardcoded-customers.sh` 之后加 `diff-onsite-ui-vs-prototype.sh` step
  - step 失败 → 阻塞 merge,提示「prototype diff 不通过,见 prototype-diff-report.md」
  - step 成功 → 上传 report 作为 PR artifact
- **Acceptance**:故意制造一条失败(revert 一个 Batch 9 任务)→ CI 红灯 → 恢复 → 绿灯
- **Commit**:`ci(onsite): prototype diff gate in PR pipeline`

### Task 10.3 — release-archivist 必跑 prototype diff

- **Modify** `docs/release-archivist-checklist.md`(若不存在则新建):
  - closure 阶段必跑 `scripts/diff-onsite-ui-vs-prototype.sh`
  - 把 `prototype-diff-report.md` 作为 release notes 的附件
  - 任何 FAIL 项必须先修才能归档
- **Commit**:`docs(onsite): release-archivist prototype diff gate`

### Task 10.4 — code-reviewer 阶段 prototype 对照环节

- **Modify** `docs/code-reviewer-checklist.md`(若不存在则新建):
  - code-reviewer 收到 PR diff 后,**必须**先打开 prototype HTML(浏览器) + 实施 UI(浏览器)并排截图对比
  - 截图作为 PR 评论附件
  - 任何 prototype 里有但实现里缺的字段/交互必须在 review comment 里列出
- **Commit**:`docs(onsite): code-reviewer prototype diff checklist`

---

## Dependency Graph(总览)

```
Batch 0 (chat 回归基线 + diff)  ──→ Batch 1 (config) ─┐
                                                       ├─→ Batch 2 (DB + ProblemService + 2.1.b migration 事务) ─┐
                                                       │                                                              ├─→ Batch 3 (routes + state machine) ─┐
                                                       │                                                              │                                       ├─→ Batch 4 (WS + 三个 discipline mw:softening/trace-id/write-protection) ─┐
                                                       │                                                              │                                       │                                                                              ├─→ Batch 5 (disallowedTools 注入 + index.js 挂载 + log-unpack) ─┐
                                                       │                                                              │                                       │                                                                              │                                                       ├─→ Batch 6 (frontend infra) ─┐
                                                       │                                                              │                                       │                                                                              │                                                       │                                ├─→ Batch 7 (frontend pages) ─┐
                                                       │                                                              │                                       │                                                                              │                                                       │                                │                                ├─→ Batch 5.5 (chat 回归门禁) → Batch 8 (CI + demo + acceptance)
                                                                                                                                                                                                                                                                                                                                                                                                                  │
                                                                                                                                                                                                                                                                                                                                                                                                                  ├─→ Batch 9 (prototype 字段对齐,纯前端增量,不动 chat) ─┐
                                                                                                                                                                                                                                                                                                                                                                                                                  │                                                                              ├─→ Batch 10 (closure diff 脚本 + CI/release-archivist 门禁)
```

每个 Batch 的内部任务严格顺序;Batch 之间串行依赖。**Batch 9 与 Batch 8 无依赖关系**,可与 Batch 8 并行实施;**Batch 10 必须在 Batch 9 完成后才能跑**。

**横切关注点**:
- `Batch 0`(前置)→ 所有 Batch 都需要回归基线对比
- `Batch 2.1.b`(migrations 事务)→ 与 Batch 2 同 Batch,合并到 Batch 2 流程
- `Batch 5.5`(后置)→ Batch 5 结束时强制执行,无新代码
- `discipline-write-protection`(`Task 4.5`)→ 与 Batch 4 的 softening/trace-id 并列,属同一中间件架构
- `Batch 9`(增量)→ 仅前端,不动 shared types 的能力层,只扩 `ProblemRecord.title?: string`(Task 9.5);不动 chat-websocket/claude-sdk/chat-run-registry
- `Batch 10`(收口)→ diff 脚本是 closure 阶段强制门禁,任何后续 batch 也必须通过它
