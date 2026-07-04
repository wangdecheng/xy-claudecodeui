# Review Brief — Batch 7 (前端页面 + 卡片 + 纪律 UI)

## 范围

`cd901cc..3a282c4`,4 个 commits,17 个新文件 + 2 个 modified:
- `e848660` feat(onsite): OnsiteLayout + sidebar list + status badge (Task 7.1)
- `2dd033a` feat(onsite): new issue wizard with three selects (Task 7.2)
- `948227b` feat(onsite): cwd lock view (Task 7.3)
- `3a282c4` feat(onsite): chat stream with cards and discipline UI (Task 7.4)

Implementer 报告:`/Users/xylink/ai/xy-claudecodeui/.superpowers/sdd/reports/batch7-implementer-report.md` — DONE_WITH_CONCERNS

## 实施者已声明的偏差(已在 brief 中预批)

1. `OnsiteWebSocketContext` 加了 `subscribe(listener)`(之前 Batch 6 没暴露,Task 7.4 需要)— 改动**只**在 `src/contexts/OnsiteWebSocketContext.tsx`,**不动** chat WS 文件
2. SofteningTag client word list 是 server 词表的子集;envelope flag + client 兜底并存
3. DisciplineCounter 是组件本地 state,切换 problem 时重置
4. IssueListSidebar 隐藏 `abandoned` 状态(留出按需展开)

## 重点审查项

### A. 客户端 TS 编译干净(必跑)

```bash
cd /Users/xylink/ai/xy-claudecodeui
npx tsc --noEmit -p tsconfig.json
```

期望:exit 0,无输出。如有错 → blocker。

### B. 关键 grep 断言(D-8 防线)

**B1. 客户/迭代/数据库下拉纯 `<select>`**(D-8 frontend 防线):

```bash
grep -nE "<input|datalist|typeahead|autoComplete|onInput" \
  src/components/onsite-analysis/CustomerSelect.tsx \
  src/components/onsite-analysis/IterationSelect.tsx \
  src/components/onsite-analysis/DatabaseSelect.tsx
```

期望:**零匹配**(只有 `<select>` 与 `<label>`)。

**B2. snake_case 字段访问**(fix 后没人再写回 camelCase):

```bash
grep -nE "thirdBridgeBranch|problemJsonPath|rootCauseText|originalName|createdAt" \
  src/components/onsite-analysis/ src/contexts/OnsiteWebSocketContext.tsx
```

期望:**零匹配**(都用 snake_case)。

**B3. OnsiteNavButton 不在 OnsiteLayout 里重复挂**(只在 App root):

```bash
grep -n "OnsiteNavButton" src/components/onsite-analysis/layout/OnsiteLayout.tsx
```

期望:零匹配。

### C. 三项必填 + 不涉及三方对接 行为

读 `src/components/onsite-analysis/NewIssueWizard.tsx`:

- 找到 `disabled={...}` 条件(三项未全时 disabled)
- 找到「不涉及三方对接」分支(`customers[0]`)→ 不传 `third_bridge_branch` 字段(传 null 也是不必要)
- 找到 OnsiteLayout placeholder 文件存在且**已替换**(不应该再看到 `data-testid="onsite-layout-placeholder"`)

### D. 用户消息右蓝气泡 / AI 消息左平铺

读 `src/components/onsite-analysis/OnsiteChatStream.tsx`:

- 找 `.msg.user` / `.msg.ai` className 或等效 class
- `cards/CardRenderer.tsx` 仅在 AI 消息上调用

### E. SofteningTag 琥珀波浪下划线

读 `src/components/onsite-analysis/SofteningTag.tsx`:

- 找到 amber/wavy 下划线 CSS(可能在 inline style / className)
- 找到 `splitSoftening`(导出)
- 确认 `RootCauseCard.tsx` / 消息 bubble 都过 `splitSoftening`

### F. DisciplineCounter:软化词 + 写原日志计数并列

读 `src/components/onsite-analysis/DisciplineCounter.tsx`:

- 两个 pill(各计数)
- envelope `discipline.softening` 累加 / `discipline.writeOriginalLog` 累加
- 切换 problem 通过 `resetKey` 重置

### G. WS 子协议零回归

```bash
git diff f1e6bb4 HEAD --stat -- \
  src/contexts/WebSocketContext.tsx \
  src/stores/useSessionStore.ts \
  server/claude-sdk.js \
  server/modules/websocket/services/chat-run-registry.service.ts \
  server/modules/websocket/services/chat-websocket.service.ts
```

期望:空 diff。

### H. 共享类型未改

```bash
git diff cd901cc HEAD -- shared/onsite-types.ts
```

期望:空 diff。

### I. 无新增 npm 包

```bash
git diff HEAD~4 HEAD -- package.json package-lock.json
```

期望:仅可能的间接 lockfile 更新;`dependencies` / `devDependencies` 字段无新增。

### J. vite build 干净

```bash
npx vite build --logLevel error
echo $?
```

期望:0。

### K. OnsiteWebSocketContext 的 subscribe 不污染 chat WS

读 `src/contexts/OnsiteWebSocketContext.tsx`:

- `subscribe(listener)` 实现是模块内闭包 + listener set
- `onmessage` 同时 dispatch `handleServerEvent`(老 batch 6 行为)与 fire all listeners
- 不动 chat WS 文件
- ⚠️ 注意:不要加了对 chat kind 的 fallback 逻辑(应只 dispatch onsite 领域的事件到 store)

### L. 实施者声明的关注(报告 §Open Questions)

按优先级:

1. **Q1 (server cwd validation for no-third-party)** —— 此 batch 不能修(backend-only);flag 为 **Important**,Batch 8 demo 时绕开(手动不点「不涉及三方对接」)
2. **Q2 (Discipline envelope flag not in shared types)** —— **Minor**,flag 已通过 `Record<string, unknown>` 防御读取;不改 shared types
3. **Q3 (no GET /messages endpoint)** —— **Important**:客户刷新页面丢失消息;不阻塞 Batch 7 收口,但 Batch 8 demo 需自己造数据
4. **Q4 (mobile sidebar)** —— 已知范围外,不强求
5. **Q5 (DisciplineCounter overlay payload)** —— **Minor**;UI shell 已就位,server payload 缺也不报错
6. **Q6 (SofteningTag client word list drift)** —— **Minor**;子集可接受(server 端是权威)

## Output

写到 `/Users/xylink/ai/xy-claudecodeui/.superpowers/sdd/reports/batch7-reviewer-report.md`:

- **Verdict**: `READY_TO_PROCEED` / `HOLD_FOR_FIX` / `BLOCKED`
- **Critical issues**(0-3 项,各带 file:line + 复现命令)
- **Important issues**(可带到 Batch 8 解决的,标 "defer to Batch 8")
- **Minor / note for later**
- **Strengths**
- **Cross-cutting verification table**(A-L 各项 PASS / FAIL / NEEDS_CONTEXT)
- **Forward compatibility for Batch 8**:demo 脚本可能踩的坑

Return 5-line status summary。

## 规则

- **独立验证**:每个 grep 都自己跑,don't trust the report
- 报告所有「snake_case」「纯 select」「no input/datalist」断言,真实命令 + 输出
- 找 Critical / Important 问题时,**给 file:line + 命令**复现
- 不要写新代码。只 review。
- 偏向允许继续 — Q1/Q3 在 Batch 8 范围内解决就够了
