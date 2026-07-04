# Review Brief — Batch 6 (前端基础设施)

## 范围

`7d66207..1f1fcf2`,4 个 commits,12 个文件,+946/-4 行。

| Commit | Task |
|---|---|
| `7d66207` | 6.1 共享类型 + onsiteStore (React hooks) |
| `1e7fd44` | 6.2 OnsiteWebSocketContext + 指数退避 |
| `4af278a` | 6.3 i18n onsite ns (zh-CN + en) |
| `1f1fcf2` | 6.4 路由 + sidebar 入口 |

## Implementer 报告

`/Users/xylink/ai/xy-claudecodeui/.superpowers/sdd/reports/batch6-implementer-report.md` — DONE_WITH_CONCERNS

**关键 concern**(已在 implementer 声明,我已核对):
- `npm run typecheck` 跑 server + client 两套 tsconfig,server 那套有 **14 个 pre-existing errors** 是 f1e6bb4(实施前 commit)就有的,实施者用 `git checkout f1e6bb4 -- server/` 回放验证。**Batch 6 客户侧 tsc 干净通过**(exit 0,no output)。

**已声明偏差**:
1. zustand → React hooks(`useSessionStore` 同模式)
2. frontend 无 test framework → 改为 tsc + dev server smoke
3. tsconfig.json 加 `@shared/*` 别名(vite.config.js 已加)
4. vite.config.js 加 `/onsite/ws` WebSocket 代理
5. Sidebar 入口**只在 desktop** 显示,mobile 走 URL
6. OnsiteLayout 是 placeholder(`data-testid="onsite-layout-placeholder"`),**留给 Batch 7**

## 重点审查项

### A. 客户端类型干净(关键)

```bash
cd /Users/xylink/ai/xy-claudecodeui
npx tsc --noEmit -p tsconfig.json
```

**期望**:exit 0,无输出。如果有错 → blocker。

### B. 共享类型与 server 端真实 schema 对齐

读 `shared/onsite-types.ts` 与下列 server 源头核对:
- `server/modules/onsite-analysis/state-machine.service.ts` —— `ProblemStatus` 枚举值
- `server/modules/database/repositories/onsite-problems.db.ts` —— `OnsiteProblemRecord` 字段
- `server/modules/onsite-analysis/config.service.ts` —— `ConfigPayload` 形态
- `server/modules/onsite-analysis/onsite.routes.ts`(POST files 207 响应)— `UploadResult`
- `server/modules/websocket/services/onsite-websocket.service.ts` —— `OnsiteServerEvent` 形态

### C. WS 指数退避数学正确性

读 `src/contexts/OnsiteWebSocketContext.tsx` 的 `nextBackoff`(或同等函数):
- 初始 ≤ 1000ms
- 每次 ×2(± jitter)
- 上限 30000ms
- 验证:`backoff sequence`:`1s, 2s, 4s, 8s, 16s, 30s (cap), 30s, 30s...`
- 验证 reconnect 在 unmount / unmount-on-token-change 下能清理 timeout

### D. Routes + Sidebar 入口 + 路由挂载点

- `src/App.tsx`:注册 `/onsite` + `/onsite/:problemId` 在 Router 内(嵌套还是平级要确认 WebSocketProvider 嵌套关系)
- `src/components/app/AppContent.tsx`:OnsiteWebSocketProvider 应**包在**用了 onsite store 的组件外层
- `OnsiteNavButton`:`useLocation()` 检查 `pathname === '/onsite' || pathname.startsWith('/onsite/')` → active class
- 不要破坏 Sidebar 已有逻辑

### E. i18n 键 parity

对比 `src/i18n/locales/zh-CN/onsite.json` 与 `src/i18n/locales/en/onsite.json`:
- 键集合相等(机器可读,排序键名对比)
- 翻译全覆盖(non-empty string for every key)

### F. 严密红线 — chat 路径零回归(contract 顶部规则)

```bash
cd /Users/xylink/ai/xy-claudecodeui
git diff --stat f1e6bb4 HEAD -- src/contexts/WebSocketContext.tsx src/stores/useSessionStore.ts server/claude-sdk.js server/modules/websocket/services/chat-run-registry.service.ts server/modules/websocket/services/chat-websocket.service.ts
```

**期望**:完全空 diff。如果有任何改动 → Critical blocker。

### G. Vite 代理不破坏 chat 路径

```bash
cat vite.config.js
```

读新增的 `/onsite/ws` proxy + `@shared` alias,确认:
- 没修改 `/ws` 现存 proxy
- 不影响 chat 行为
- `@shared` alias 是新增条目,非 rename

### H. Pre-existing server tsc errors 不被 Batch 6 引入

implementer 已用 `git checkout f1e6bb4 -- server/` 回放验证 14 个 errors 都在。

**请独立 verify**:
```bash
git checkout f1e6bb4 -- server/
npx tsc --noEmit -p server/tsconfig.json 2>&1 | grep "error TS" | wc -l
git checkout HEAD -- server/
npx tsc --noEmit -p server/tsconfig.json 2>&1 | grep "error TS" | wc -l
```

**期望**:两个计数 ≥ 14 且相等;或 Batch 6 计数 <= pre-existing 计数。如果 Batch 6 引入新 error → 记为 Important。

### I. Dev server 验证

implementer 已验证 `/onsite` 与 `/onsite/abc-123` 返 200。请再次确认:
```bash
npx vite &
sleep 3
curl -s -o /dev/null -w "/onsite: %{http_code}\n" http://localhost:5173/onsite
curl -s -o /dev/null -w "/onsite/abc: %{http_code}\n" http://localhost:5173/onsite/abc-123
curl -s -o /dev/null -w "/: %{http_code}\n" http://localhost:5173/
# 然后 kill vite
```

期望 200 / 200 / 200。

### J. 实施者识别的 7 个开放问题(§7 of report)

按优先级关注:
- Q1(selectors vs hooks 命名)— 1/3 优先级
- Q2(state-changed 全 reload)— 中等,设计抉择
- Q3(vite proxy)— 中等,部署侧需确认
- Q4(mobile sidebar 不挂)— 可接受,Batch 7 补
- Q5(tsconfig paths)— 已说明,需 agree
- Q6(userId localStorage key)— **Important** — 错的 key 会让审计无 userId
- Q7(...)— Already 已回答

## Output

写到 `/Users/xylink/ai/xy-claudecodeui/.superpowers/sdd/reports/batch6-reviewer-report.md`:

- **Verdict**:Ready to proceed / Hold for fix(es) / Blocked
- **Critical issues**(0-3 项,每项 git 路径 + 行号 + 复现命令)
- **Important issues**
- **Minor / note for later**
- **Strengths**
- **Cross-cutting 验证**(A-J 各项 pass/fail 表格)
- **Forward compatibility for Batch 7**

返回 5 行状态摘要。
