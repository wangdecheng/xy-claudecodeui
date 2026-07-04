# Task Brief — Batch 7 (前端页面 + 卡片 + 纪律 UI)

## 范围(来自 tasks.md §Batch 7)

| Task | 组件 | 关键验收 |
|---|---|---|
| **7.1** | OnsiteLayout + IssueListSidebar + IssueListItem + StatusBadge | 左侧 300px 侧栏 + 右侧 chat outlet;列表按 blocked/analyzing/pending_info/confirmed 分组 |
| **7.2** | NewIssueWizard + CustomerSelect/IterationSelect/DatabaseSelect + LogUploader + NoThirdPartyHint | 客户未选 → 提交 disabled;三项全选 → enabled;**客户下拉必须纯 `<select>`,无 input/datalist/typeahead**(D-8);选首项「不涉及三方对接」 → branch=null;上传 21 文件 → 客户端截到 20 |
| **7.3** | CwdLockView | 🔒 ~/work/.../<dir>,长路径中间截断,hover 完整 |
| **7.4** | OnsiteChatStream + 4 卡片(Evidence/Blocked/RootCause/Sql) + CardRenderer + SofteningTag + DisciplineCounter | 用户消息右蓝气泡;AI 消息左平铺;软化词琥珀波浪下划线;软化词计数 + 写原日志计数并列 |

## 后端已就位的 API 形状(必须对齐 snake_case — fix 已落)

```ts
// shared/onsite-types.ts
type ProblemStatus = 'pending_info' | 'analyzing' | 'blocked' | 'confirmed' | 'abandoned';
interface ProblemRecord {
  id: string;
  customer: string;
  third_bridge_branch: string | null;   // 是 snake_case,不是 thirdBridgeBranch
  iteration: string;
  database: string;
  status: ProblemStatus;
  cwd: string;
  problem_json_path: string | null;
  root_cause_text?: string | null;
}
interface ConfigPayload {
  status: 'OK' | 'INVALID';
  mtime: string;
  data: { customers: { label: string; branch: string | null }[]; iterations: string[] };
  error?: string;
}
```

API 路由:
- `GET /api/onsite/config` → `ConfigPayload`
- `GET /api/onsite/problems` → `ProblemRecord[]`(server 已按 blocked → analyzing → pending_info → confirmed → abandoned 排序)
- `GET /api/onsite/problems/:id/files` → `OnsiteFile[]`
- `POST /api/onsite/problems/:id/files` → 207 + `UploadResult[]`
- `PATCH /api/onsite/problems/:id` `{status, reason}` → 200/409/400

WS `/onsite/ws` 已 dispatch:
- `{type:'problems:changed'}` → reload list
- `{type:'problem:<id>:state-changed', payload:{status,reason,at}}` → reload list
- AI 助手消息 envelope `discipline:{softening: true|false, traceIdEmpty: true|false, traceIdSuspect: true|false, writeOriginalLog: true|false}`(flag 直接读,不要再解析 XML `<softening>`)

## 从 Batch 6 直接可用(必读)

### 共享类型与 store

```ts
// src/stores/onsiteStore.tsx
import { useOnsiteStore } from '@/stores/onsiteStore';
const {
  problems, config, currentProblemId, uploading, lastError,
  loadConfig, loadProblems, selectProblem, patchStatus, uploadFiles,
  getProblem,            // 注意:不带 use 前缀
  getUploadProgress,
  getAnyUploading,
} = useOnsiteStore();
```

### WS context

```tsx
import { useOnsiteWebSocket } from '@/contexts/OnsiteWebSocketContext';
const { isConnected, setHelloContext, send } = useOnsiteWebSocket();
```

- **问题切换时**:`setHelloContext(problemId, problem.cwd)` 让 server 看到正确 cwd
- `send(frame)` 用于发聊天消息给 onsite 路径(略,Batch 7 范围内仅 chat.send 形式,具体 protocol 后端已在 Batch 5 实装)

### i18n

```ts
import { useTranslation } from 'react-i18next';
const { t } = useTranslation(['onsite', 'common']);
t('onsite:wizard.title')   // 拿「新建问题」之类
```

可用的 key(由 Batch 6 锁):
```
nav.onsite / wizard.title / wizard.customer / wizard.iteration / wizard.database /
wizard.upload / wizard.thirdPartyHint / wizard.noThirdParty / wizard.submit /
wizard.createSuccess / wizard.createFailed /
status.{pending_info, analyzing, blocked, confirmed, abandoned} /
error.{configInvalid, networkError, uploadFailed, reasonTooShort, invalidTransition} /
discipline.{softeningTag, suspectToast, writeProtectionCounter} /
common.{back, loading, empty, retry}
```

### Sidebar 入口

`<OnsiteNavButton />` 已挂在 desktop sidebar;**mobile 未挂**(Batch 7 不补)。

### OnsiteLayout 占位

`src/components/onsite-analysis/layout/OnsiteLayout.tsx` 是 placeholder(`data-testid="onsite-layout-placeholder"`)。**Batch 7 替换为真布局**:

```tsx
<OnsiteLayout> 结构:
  <aside className="issue-list-sidebar">
    <OnsiteNavButton />     // 不是 — 已经在 AppContent 顶层挂,不要重复
    <IssueListSidebar />    // 见 Task 7.1
  </aside>
  <main className="onsite-main">
    {problemId ? <OnsiteChatStream problemId={problemId} /> : <EmptyState />}
  </main>
</OnsiteLayout>
```

## 详细实现要点

### Task 7.1 — Sidebar + Layout + StatusBadge

**OnsiteLayout**(替换现有 placeholder):
- 接收 `useParams<{problemId?: string}>()` 决定右侧渲染
- 左 300px + 右 flex 1 main
- 注入 `<OnsiteWebSocketProvider />` 的 `setHelloContext(problemId, cwd)` effect(可选,放 chat mount 时更准)

**IssueListSidebar**:
- 顶部「+ 新建」按钮(trigger wizard 模态)
- 搜索框(client 端过滤 customer)
- 分组:server 已按 status 排序,但 client 端要按 status 分组渲染 4 个 section(h2 + 列表)

**IssueListItem**:
- customer 名 + `<StatusBadge status={...}/>`
- cwd 目录名(取最后一段,即 `20260704-山西公安`)
- iteration + database chip
- 相对时间(从 cwd 推到 `created_at`;若不存在,fallback 到当前时间)
- 点击 → `selectProblem(id)` + navigate 到 `/onsite/${id}`

**StatusBadge**:
- 4 色:pending_info 灰 / analyzing 蓝 / blocked 琥珀 / confirmed 绿 / abandoned 暗灰
- 用 i18n `t('onsite:status.<key>')` 拿文字

### Task 7.2 — Wizard + 3 Selects + Uploader + NoThirdPartyHint

**CustomerSelect**:**纯 `<select>`**,**NO input/datalist/typeahead/Autocomplete**!D-8 双层防线之一
```tsx
<select value={customer} onChange={(e) => setCustomer(e.target.value)}>
  <option value="" disabled>请选择客户…</option>
  {config.data.customers.map(c => (
    <option key={c.label} value={c.label}>{c.label}</option>
  ))}
</select>
```
- `config.status === 'INVALID'` 时,在 select 上方/下方显示红字「配置加载失败」+ 把**所有** select disabled

**IterationSelect** + **DatabaseSelect**:同模式

**NoThirdPartyHint**:
- 当 `selectedCustomer === config.data.customers[0].label` (即首项 = 不涉及三方对接) 显示提示卡片「此客户不涉及三方对接,branch 字段将设为 null」
- 同时确保提交时 `branch=null` 不传给 server(传给会让 server 校验失败,因为首项的 branch 在 schema 里是 null)

**LogUploader**:
- 拖拽区 + `<input type="file" multiple>`
- 选完后,**客户端**先截到 20(超出给 warning toast)
- 上传进度条:从 `useOnsiteStore().getUploadProgress(problemId)` 拿 — store 已经维护 `uploading[problemId]` map
- 大文件 > 200MB 本地 alert + 截到 200MB 还是拒绝?(参照 `LogUploader.test` contract 的「单包超 200MB 客户端先截掉」约定 — 推荐先截 + warning)

**NewIssueWizard**:
- 模态
- 三步合一表单:CustomerSelect + IterationSelect + DatabaseSelect + LogUploader(可选)
- `useEffect`:mouting 时 `loadConfig()` + `loadProblems()`(防止上一会话遗留)
- Submit button disabled when:
  - `config.status !== 'OK'`
  - customer 未选
  - iteration 未选
  - database 未选

### Task 7.3 — CwdLockView

```tsx
<div className="cwd-lock" title={cwdFull}>
  🔒 {shortenedCwd}
</div>
```
- 简化逻辑:取 cwd 最后一段 + 倒数第二段前缀两个字符(例:`~/wo/.../20260704-山西公安`)
- 全 cwd 在 `title` 属性(mouse hover 显示)

### Task 7.4 — Chat Stream + 卡片 + 软化词 UI

**OnsiteChatStream**:
- `useEffect` mount 时:
  - `setHelloContext(problemId, problem.cwd)`(从 store 拿 cwd)
  - `loadProblems()`(刷新保证状态最新)
- 拉消息:`useState<NormalizedMessage[]>([])` + WS subscribe
  - 每条 `useOnsiteWebSocket().subscribe(handler)` callback,过滤 `event.sessionId === problemId` 且 `event.kind` 在 {`text`, `tool_use`, `tool_result`, `thinking`, `stream_delta`, `complete`} 范围
- 用户消息(`.kind === 'text' && .role === 'user'`)用 `.msg.user` 样式(右蓝气泡,头像在右)
- AI 消息(`.kind === 'text' && .role === 'assistant'`)用 `.msg.ai` 样式(左平铺,无气泡,CardRenderer 渲染)
- 工具消息用缩进 + 灰底
- 顶部:`<CwdLockView cwd={problem.cwd}/>` + `<StatusBadge status={problem.status}/>` + `<DisciplineCounter problemId={problem.id}/>`
- 底部输入框:`<textarea>`,Enter 发送 / Shift+Enter 换行

**CardRenderer**:
- 根据 AI 消息内容解析 `<card type="...">` 标签(由后端 AI 在生成时注入;若项目还没定义 card 协议,可用 markdown 风格 fallback)
- 4 个 card type:`EvidenceCard`(🔍 灰)/ `BlockedCard`(⛔ 琥珀)/ `RootCauseCard`(✅ 绿)/ `SqlCard`(📋)
- 不识别的 type → 渲染原文(不报错)

**SofteningTag**:
- 包裹文本中的软化词(可能/也许/大概/might/maybe/perhaps/seems 等)
- 样式:琥珀色(amber-500)波浪线下划线 + `title={t('onsite:discipline.softeningTag')}` + 鼠标 hover 显示计数工具提示
- **实现方式**:用后端 envelope `discipline.softening` flag 检测消息,或在 client 端用 `findWords` 同样扫一遍,然后把命中的 span 包成 SofteningTag(replace 函数)
- **状态**:Batch 7 范围内允许两种方式并存 — envelope 优先级高 + client 兜底

**DisciplineCounter**:
- 头部两个 pill:
  - `本会话软化词 N 处`(envelope `discipline.softening` 命中累计)
  - `写原日志 N 处`(envelope `discipline.writeOriginalLog` 命中累计)
- 各自的 N 为本次 onsite session 的累计;点击展开 onsite_discipline_log(后端 GET 端点已存在,前置 Batch 4)

## ⚠️ Contract 偏差(沿用 Batch 6 同一套)

1. **frontend 无 test framework** → 不要新增 vitest。继续用 tsc + dev server smoke
2. **CustomerSelect 必须纯 `<select>`** → 这是 D-8 双层防线的前端防线(后端防线 = 未来 Batch 8 `validate-no-hardcoded-customers.sh`)
3. **数据 snake_case** → 全程用 `problem.third_bridge_branch` 而不是 `problem.thirdBridgeBranch`
4. **OnsiteNavButton 不在 mobile** → 不要为 mobile 重复挂

## 完成标准(contract §Batch 7)

- NewIssueWizard 客户未选 → 提交按钮 disabled
- 三项全选 → 提交按钮 enabled
- 选「不涉及三方对接」→ branch 字段 null(POST 时不传 branch 字段)
- 客户下拉**纯 `<select>`**,无 input/datalist/typeahead
- 用户消息右蓝气泡,AI 消息左平铺
- 软化词被 SofteningTag 包成琥珀波浪线
- 软化词计数 + 写原日志计数 + suspect toast 都正常

## TDD 调整路线(同 Batch 6)

每个 Task 至少:
- TS 类型/strict 模式安全
- 浏览器手动 smoke(描述步骤)

## 提交策略

按 Task 分 commit:
1. `feat(onsite): OnsiteLayout + sidebar list + status badge (Task 7.1)`
2. `feat(onsite): new issue wizard with three selects (Task 7.2)`
3. `feat(onsite): cwd lock view (Task 7.3)`
4. `feat(onsite): chat stream with cards and discipline UI (Task 7.4)`

(若某 Task 太小,可合到下一个 commit。)

## 报告

写 `/Users/xylink/ai/xy-claudecodeui/.superpowers/sdd/reports/batch7-implementer-report.md`:
- Status (DONE / DONE_WITH_CONCERNS / BLOCKED)
- Files created/modified
- Commits
- tsc 输出(`npm run typecheck 2>&1 | tail -30` — pre-existing 30 server errors 仍会有,确认 client 干净)
- 手动 smoke 测试清单与输出
- 关键设计抉择(especial SofteningTag 的 client-side vs envelope)
- Batch 8 inputs(named exports + 静态扫描需要看的 grep pattern)
- Open questions

回 5 行状态摘要。

## 红线

- **不动**:`server/claude-sdk.js` / `chat-websocket.service.ts` / `chat-run-registry.service.ts` / `src/contexts/WebSocketContext.tsx` / `src/stores/useSessionStore.ts` / `src/i18n/config.js` 中的 chat 翻译部分
- **不引入新 npm 包**
- **不改** `shared/onsite-types.ts` 字段(已经 fix 过 snake_case)
- **不删除或重命名** Batch 6 创建的 `OnsiteLayout` placeholder 文件 — 替换其内容,但保留 path

Begin now.
