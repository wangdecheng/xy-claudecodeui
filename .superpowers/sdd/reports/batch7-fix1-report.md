# Batch 7 Fix 1 Report — C1: DisciplineCounter 状态架构断开

## Status
**DONE** — C1 fixed, M1 (硬编码 `.slice(0, 4)`) 一并修复，I1/I2/I3 延后到 Batch 8。

## Files modified
- `src/components/onsite-analysis/DisciplineCounter.tsx` — 改为纯受控组件，删除内部 `useState` slots 和 `void problemId/setSoftCount/setWriteCount/setLog` no-op 占位；接受 `softening` / `writeOriginalLog` / `log` 三个 props。
- `src/components/onsite-analysis/OnsiteChatStream.tsx` — `DisciplineState` 扩展含 `log: DisciplineLogEntry[]`；`useState` 改为含完整字段；WS 回调中追加日志条目；渲染处传入 props；移除 `problemId`/`resetKey` 透传。

## Commit
```
ad924b4 fix(onsite): wire DisciplineCounter tallies to OnsiteChatStream state
```
(`git log --oneline -3` 输出)
```
ad924b4 fix(onsite): wire DisciplineCounter tallies to OnsiteChatStream state
3a282c4 feat(onsite): chat stream with cards and discipline UI (Task 7.4)
948227b feat(onsite): cwd lock view (Task 7.3)
```

## tsc output
```
$ npx tsc --noEmit -p tsconfig.json
EXIT=0
```
零错误。

## Grep 验证

### 1) 删除 dead state slots
```
$ grep -nE "softCount|writeCount|setSoftCount|setWriteCount" src/components/onsite-analysis/ -r
（零匹配）
```

### 2) Props 流验证
```
$ grep -nE "softening=|writeOriginalLog=" src/components/onsite-analysis/OnsiteChatStream.tsx
263:            softening={discipline.softening}
264:            writeOriginalLog={discipline.writeOriginalLog}
```
（命中 2 处 — 传 props）

### 3) Protected files 零 diff
```
$ git diff f1e6bb4 HEAD --stat -- src/contexts/WebSocketContext.tsx src/stores/useSessionStore.ts server/claude-sdk.js
（空 — chat 路径零回归）

$ git diff cd901cc HEAD -- shared/onsite-types.ts
（空 — shared types 不动）

$ git status --short -- src/components/onsite-analysis/ src/contexts/WebSocketContext.tsx src/stores/useSessionStore.ts server/claude-sdk.js shared/onsite-types.ts
 M src/components/onsite-analysis/DisciplineCounter.tsx
 M src/components/onsite-analysis/OnsiteChatStream.tsx
```
（只有上述 2 个 onsite 文件 modified，5 个 chat-path + shared types 未动）

## Diff stats for protected files
- `src/contexts/WebSocketContext.tsx` — **0 行** （vs `f1e6bb4`..HEAD）
- `src/stores/useSessionStore.ts` — **0 行**
- `server/claude-sdk.js` — **0 行**
- `shared/onsite-types.ts` — **0 行** （vs `cd901cc`..HEAD）

## C1 修复细节
- **State lift**: `discipline` state 完整存在于 `OnsiteChatStream`，含 `{ softening, writeOriginalLog, log }`。
- **WS tally**: subscribe 回调继续累加 `softening` / `writeOriginalLog`，并把每条 discipline 事件追加到 `log`，用于 overlay。
- **Props flow**: `<DisciplineCounter softening={...} writeOriginalLog={...} log={...} />` — 真正的数据流接通，pill 不再永远显示 "0"。
- **Reset**: problem switch 时 `setDiscipline({ softening: 0, writeOriginalLog: 0, log: [] })` 在 `useEffect([problemId, problem, setHelloContext])` 中执行。
- **M1 顺手修**: `DisciplineCounter` 删除了硬编码 `.slice(0, 4)`，改为 `{softening}` 直接渲染 count；`'logs 0'` 也改为 `{t('onsite:discipline.writeProtectionCounter')} {writeOriginalLog}`，通过 i18n 渲染。
- **API surface**: `DisciplineCounter` 新 props 是 `softening: number` / `writeOriginalLog: number` / `log: DisciplineLogEntry[]`；旧的 `problemId` / `resetKey` 删除。

## I1/I2/I3 deferred to Batch 8
- I1 (GET /messages) — 未触及（persistence OOS）
- I2 (no-third-party cwd) — 未触及（属于 layout 层）
- I3 (envelope flag in shared types) — 未触及（需要 server 协同）

## 其他发现（未修）
- `OnsiteChatStream.tsx` 内仍有一段被 reviewer 标注的 dead loop：
  ```ts
  for (let i = cur.length - 1; i >= 0; i -= 1) {
    const m = cur[i];
    if (m && m.kind === 'text' && m.role === 'assistant') {
      return [...cur];  // 仅克隆，未修改任何消息
    }
  }
  ```
  这是 pre-existing 代码，与本次 C1/M1 修复无关，留待后续清理（I4?）由 Batch 8 决定。
- `discipline.word` 字段 server 端 schema 未明确 — 当前代码做防御性 `typeof d.word === 'string'` 判断，OK。

## 红线复核
- chat-path 5 文件零 diff — **通过**
- `shared/onsite-types.ts` 零 diff vs `cd901cc` — **通过**
- `npx tsc --noEmit -p tsconfig.json` exit 0 — **通过**
- 无新增 npm 包 — **通过**
- 单 commit — **通过**
- 仅修改 2 个目标文件 — **通过**