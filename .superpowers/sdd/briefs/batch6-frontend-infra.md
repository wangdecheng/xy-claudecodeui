# Task Brief — Batch 6 (前端基础设施)

## 范围(来自 tasks.md §Batch 6)

| Task | 任务 | 验收 |
|---|---|---|
| **6.1** | `shared/onsite-types.ts` + `src/stores/onsiteStore.ts` | TS 类型 + actions(loadConfig/loadProblems/selectProblem/patchStatus/uploadFiles) |
| **6.2** | `src/contexts/OnsiteWebSocketContext.tsx` | `/onsite/ws` 单例 + 指数退避(上限 30s) + 首帧 `{kind:'onsite', problemId, cwd, userId}` + 收到 `problems:changed` / `problem:<id>:state-changed` 更新 store |
| **6.3** | `src/i18n/locales/{zh-CN,en}/onsite.json` + 在 `src/i18n/config.js` 注册 `onsite` ns | 全部键双语存在(`nav.onsite` / `wizard.title` / `wizard.customer` 等) |
| **6.4** | `src/App.tsx` 路由 `/onsite` + `/onsite/:problemId` + Sidebar 入口按钮 | active 状态匹配 `/onsite/*` |

## 关键依赖(Batch 1-5 已就位)

后端 API:
- `GET /api/onsite/config` → `ConfigPayload`
- `GET /api/onsite/problems` → `ProblemListItem[]`
- `GET /api/onsite/problems/:id` → `ProblemRecord`
- `PATCH /api/onsite/problems/:id` → state change
- `POST /api/onsite/problems/:id/files` → 上传
- WS `/onsite/ws` → broadcast `problems:changed` / `problem:<id>:state-changed`

## ⚠️ Contract 偏差(需在报告中显式声明,user 已认同沿用现有模式)

### 偏差 A:`zustand` 不在 package.json 中

执行合同说"用现有 zustand",但 package.json **没有** zustand 依赖。同时 contract 顶层规则 §依赖约束 又禁止新增 npm 包。

**决策**:沿用 **React hooks 模式**(参照 `src/stores/useSessionStore.ts` 的 `useRef + useState + useCallback + useMemo`)。这样保持 0 新增 npm 包 + 与 codebase 一致性。

**实现要点**:
```ts
// src/stores/onsiteStore.tsx(改后缀)
import { useCallback, useRef, useState, useMemo } from 'react';
export function useOnsiteStore() {
  const stateRef = useRef({...});
  const [, setTick] = useState(0);
  const notify = useCallback(() => setTick(n => n + 1), []);
  // ...getter/setter 通过 immutable spread
}
```

实现要保证:hook 行为跟 zustand 的 `useStore(selector)` 类似 — 选 state 字段 + 拿到 actions。**Re-export** 为 `useOnsiteStore()` 形式(不是全局 store)。

> **注**:contract 写为"zustand store",你是用 React hooks 实现等价 API,但语义/接口签名要满足 contract 验收。

### 偏差 B:前端无测试框架

package.json **没有** `vitest` / `jest` / `@testing-library/react`。spec-superflow TDD 铁律说"无失败测试不得写代码",但前端无 test runner。

**决策**:
1. **不要**新增 vitest(CI 不接受这个 scope creep)
2. **adapted TDD**:每个 Task 至少做:
   - TypeScript 类型签名设计(`tsc --noEmit -p tsconfig.json` 通过)
   - 关键纯函数写最小 `console.assert` 或手写 `node --import tsx` 跑(cjs)
   - 集成通过浏览器手动验(`npm run dev` + `curl localhost:5173/onsite`)
3. **报告**里说明此偏差,列出手动验证清单
4. **不要**编造虚假 test 文件凑数

## 现有模式参考(必读)

### React hooks store 模板(`src/stores/useSessionStore.ts:418-732`)

```ts
export function useSessionStore() {
  const storeRef = useRef(new Map<string, SessionSlot>());
  const [, setTick] = useState(0);
  const notify = useCallback((sessionId: string) => {
    if (sessionId === activeSessionIdRef.current) setTick(n => n + 1);
  }, []);

  const fetchFromServer = useCallback(async (sessionId: string, opts) => {
    const slot = getSlot(sessionId);
    slot.status = 'loading';
    notify(sessionId);
    try {
      const res = await authenticatedFetch(url);
      // ...
      slot.serverMessages = messages;
      notify(sessionId);
    } catch (e) { /* ... */ }
  }, [getSlot, notify]);

  return useMemo(() => ({...}), [...]);
}
```

**onsiteStore 需包含**(actions 列表):
- `loadConfig(): Promise<void>` → GET `/api/onsite/config` 落 store
- `loadProblems(): Promise<void>` → GET `/api/onsite/problems` 落 store  
- `selectProblem(id: string | null): void` → 设置 `currentProblemId` + 触发 onselect listener
- `patchStatus(id: string, to: ProblemStatus, reason: string): Promise<void>` → PATCH
- `uploadFiles(id: string, files: File[]): Promise<UploadResult[]>` → POST(进度通过 `uploading` map 暴露)
- **Selector actions**(subscribe): `useProblemList()`, `useCurrentProblem()`, `useConfig()`, `useUploadProgress(id)`

### WS Context 模板(`src/contexts/WebSocketContext.tsx:61-179`)

已有 chat WS 用固定 3s 重连。新 OnsiteWS 要 **指数退避上限 30s**:

```ts
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

function nextBackoff(prevMs: number): number {
  const jitter = Math.random() * 0.3 * prevMs;
  return Math.min(MAX_BACKOFF_MS, prevMs * 2 + jitter);
}
```

**接口**:
- `WebSocket('ws://<host>/onsite/ws?token=...')`(复用 `authenticatedFetch` 的 token 模式)
- `onopen` → 发首帧 `{kind:'onsite', problemId, cwd, userId}`(problemId/cwd 可为 placeholder,待 Batch 7 切换时重发)
- `onmessage` 派发两种消息:
  - `{type: 'problems:changed'}` → `onsiteStore.loadProblems()`
  - `{type: 'problem:<id>:state-changed', payload: {status, reason, at}}` → 更新 store
- `onclose` → 用 `setTimeout(connect, backoff)` 退避;`backoff *= 2`(封顶 30s)

### i18n 模式(`src/i18n/config.js`)

- 命名空间:`ns: ['common', 'settings', 'auth', 'sidebar', 'chat', 'codeEditor', 'tasks', 'onsite']`
- 每个语言资源 object:`en.onsite`、`zh-CN.onsite` 等
- 至少 en + zh-CN 两个文件
- 完整键列表见 contract / tasks.md:
  - `nav.onsite`:`'🔍 客户现场分析'` / `'🔍 Customer Onsite Analysis'`
  - `wizard.title` / `wizard.customer` / `wizard.iteration` / `wizard.database` / `wizard.upload` / `wizard.thirdPartyHint` / `wizard.noThirdParty`
  - `wizard.submit` / `wizard.createSuccess` / `wizard.createFailed`
  - `status.pending_info` / `status.analyzing` / `status.blocked` / `status.confirmed` / `status.abandoned`
  - `error.configInvalid` / `error.networkError` / `error.uploadFailed`
  - `discipline.softeningTag` / `discipline.suspectToast` / `discipline.writeProtectionCounter`

### Sidebar 入口(`src/components/sidebar/view/Sidebar.tsx` + subcomponents)

- Sidebar 是 **controller-driven**(state 由 `useSidebarController` 拿;本身很瘦)
- 不要大改 Sidebar — 提取一个 `<OnsiteNavButton />` 到 `src/components/onsite-analysis/nav/OnsiteNavButton.tsx`,用 `useLocation()` 检查 active 状态,`useNavigate()` 跳转
- 主 App.tsx 注册时 `Sidebar` 旁边挂这个按钮(查看 `AppContent` 怎么用 Sidebar,把 `<OnsiteNavButton />` 放在它附近)

### 路由(`src/App.tsx`)

```tsx
<Routes>
  <Route path="/onsite" element={<OnsiteLayout />} />
  <Route path="/onsite/:problemId" element={<OnsiteLayout />} />
</Routes>
```

注:`OnsiteLayout` 在 Batch 7 才有具体实现;Batch 6 先 **创建最小 placeholder**(<div>Batch 7 placeholder</div>),让路由不报错。等 Batch 7 替换。

## TDD 调整路线(adapted)

每个 Task 走:design type → stub → fail(尝试 `tsc --noEmit` 看错误)→ 实现 → pass(再次 `tsc --noEmit` 通过)→ 手动 page-load smoke。

| Task | 失败信号 | 通过信号 |
|---|---|---|
| 6.1 | `tsc --noEmit` 报 onsite-types + onsiteStore 类型错误 | tsc 通过 + dev server 启动不报 module 找不到 |
| 6.2 | `tsc --noEmit` 报 OnsiteWSContext 类型 / re-export 错误 | tsc 通过 + 在 dev tools console 手动 `new WebSocket('ws://...')` 验证 socket 建立 |
| 6.3 | 缺失键 `i18next` 警告(运行时) | `console.log(t('onsite:wizard.title'))` 输出非 fallback 字符串 |
| 6.4 | Sidebar 找不到按钮 / Route path 不匹配 / active 类名不变 | 浏览器访问 `/onsite` 返回 200(不是 404)+ DOM 看到按钮 |

## 完成标准(from contract §Batch 6)

- sidebar 显示「客户现场分析」按钮,active 状态匹配 `/onsite/*`
- WS 自动重连(指数退避,上限 30s)
- i18n `onsite:wizard.title` 等键 zh-CN + en 都有
- TS 编译通过(`npm run typecheck`)
- 不影响 chat 路径(`src/contexts/WebSocketContext.tsx` 零改动)

## 重要约束

- **绝不能碰**:`server/claude-sdk.js` / `chat-websocket.service.ts` / `chat-run-registry.service.ts` / `claude-sdk.js`
- **不能新增 npm 包**(包括 zustand)
- 不修改已有 `useSessionStore.ts` 以外的业务 store
- Sidebar 入口按钮是**新增组件**(不改 Sidebar.tsx 现有逻辑)
- 路由注册时 `OnsiteLayout` 是 placeholder(`<div data-testid="onsite-layout-placeholder">Batch 7</div>`),不做布局工作

## 报告

写到 `.superpowers/sdd/reports/batch6-implementer-report.md`:

1. **DONE_WITH_CONCERNS** 或 **DONE**?
2. 文件清单(每个 Task 创建/改了哪些文件)
3. Contract 偏差汇总(zustand → React hooks + frontend TDD → 编译+smoke)
4. TypeScript 编译输出(`npm run typecheck` 完整结果)
5. 手动 smoke 清单(浏览器/console 各步骤)
6. 下一个 Batch(7)需要的 I/O 接口(命名导出 list)

不要写全文 contract — 写**当前 batch 范围内**的事实。
