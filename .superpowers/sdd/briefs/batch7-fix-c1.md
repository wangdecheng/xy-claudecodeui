# Fix Brief — Batch 7 C1(DisciplineCounter 状态架构断开)

## 来源

Reviewer 报告:`/Users/xylink/ai/xy-claudecodeui/.superpowers/sdd/reports/batch7-reviewer-report.md`

## 必修(Critical)

### C1 — DisciplineCounter pill 永远显示 "0"

**症状**:头部两个 pill 永远显示 `soft 0` / `logs 0`,无论 server 推多少 discipline 事件。

**根因**(reviewer 已定位):
- `OnsiteChatStream.tsx:75`:`const [, setDiscipline] = useState(...)` — 读取侧被丢弃
- `DisciplineCounter.tsx:30-31`:自己的 `useState` slots 从未被写入
- 两个组件之间**没有数据流**(props 没传)
- `void setSoftCount; void setWriteCount;` 是 no-op 占位

**修复方案**(reviewer 推荐 #1):**把 tallies 提到 `OnsiteChatStream`,通过 props 传给 `DisciplineCounter`**。

```tsx
// OnsiteChatStream.tsx
const [discipline, setDiscipline] = useState({
  softening: 0,
  writeOriginalLog: 0,
  log: [] as Array<{ kind: string; at: string; cmd?: string }>,
});

// 现有 WS subscribe callback 调:
setDiscipline((prev) => ({
  ...prev,
  softening: prev.softening + (ev.discipline?.softening === true ? 1 : 0),
  writeOriginalLog: prev.writeOriginalLog + (ev.discipline?.writeOriginalLog === true ? 1 : 0),
  log: [...prev.log, /* 新条目 */],
}));

// reset on problem switch:
useEffect(() => {
  setDiscipline({ softening: 0, writeOriginalLog: 0, log: [] });
}, [problemId]);

// render:
<DisciplineCounter
  softening={discipline.softening}
  writeOriginalLog={discipline.writeOriginalLog}
  log={discipline.log}
/>
```

```tsx
// DisciplineCounter.tsx — 改为接受 props,删除内部 useState
interface DisciplineCounterProps {
  softening: number;
  writeOriginalLog: number;
  log: Array<{ kind: string; at: string; cmd?: string }>;
}

function DisciplineCounter({ softening, writeOriginalLog, log }: DisciplineCounterProps) {
  const { t } = useTranslation(['onsite']);
  // ... render
  <span>{t('onsite:discipline.softeningTag')} {softening}</span>
  <span>{t('onsite:discipline.writeProtectionCounter')} {writeOriginalLog}</span>
  // overlay log 列表
}
```

**注意**:
- `resetKey` props 现在用不上,从 DisciplineCounter 删除;reset 由 OnsiteChatStream 的 `useEffect([problemId])` 处理
- 顺手修 M1(去掉 `.slice(0, 4)`)

## 范围(必清)

只动 2 个文件:
- `src/components/onsite-analysis/DisciplineCounter.tsx`
- `src/components/onsite-analysis/OnsiteChatStream.tsx`

## 验证

```bash
npx tsc --noEmit -p tsconfig.json
echo $?  # 期望 0

# grep 关键符号
grep -n "softCount\|writeCount\|setSoftCount\|setWriteCount" src/components/onsite-analysis/
# 期望:零匹配(已删除)

# 验证 props 流
grep -nE "softening=|writeOriginalLog=" src/components/onsite-analysis/OnsiteChatStream.tsx
# 期望:命中 1-2 处(传 props)

# 验证 chat path / shared types 不动
git diff f1e6bb4 HEAD --stat -- src/contexts/WebSocketContext.tsx src/stores/useSessionStore.ts server/claude-sdk.js
# 期望:空
git diff cd901cc HEAD -- shared/onsite-types.ts
# 期望:空
```

## 不修(后续 Batch 8 处理)

- I1 (GET /messages)
- I2 (no-third-party cwd)
- I3 (envelope flag in shared types)
- M1 已含在本 fix
- M2-M5 不修

## 报告

写 `/Users/xylink/ai/xy-claudecodeui/.superpowers/sdd/reports/batch7-fix1-report.md`:
- Status
- Files modified
- Commit hash + message
- tsc 输出
- 验证 grep 输出
- Diff stat 5 个 chat 文件 + shared types

## 提交信息

`fix(onsite): wire DisciplineCounter tallies to OnsiteChatStream state`

## 红线

- 不改 chat WS / 5 个 chat path 文件
- 不改 shared/onsite-types.ts
- 不引入新 npm 包
- 单 commit

回 5 行状态摘要。
