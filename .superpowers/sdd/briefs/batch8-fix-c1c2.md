# Fix Brief — Batch 8 C1 + C2

## 来源

`/Users/xylink/ai/xy-claudecodeui/.superpowers/sdd/reports/batch8-reviewer-report.md` — HOLD_FOR_FIX

## 必修(2 Critical)

### C1 — I3 union 类型 narrowing 缺失(client tsc 3 错)

**症状**:
```
src/contexts/OnsiteWebSocketContext.tsx(147,17): error TS2339: Property 'type' does not exist on type 'OnsiteServerEvent'.
  Property 'type' does not exist on type 'OnsiteChatFrame'.
src/contexts/OnsiteWebSocketContext.tsx(153,66): error TS2339: Property 'type' does not exist on type 'OnsiteServerEvent'.
  Property 'type' does not exist on type 'OnsiteChatFrame'.
src/contexts/OnsiteWebSocketContext.tsx(156,31): error TS2339: Property 'payload' does not exist on type 'OnsiteServerEvent'.
  Property 'payload' does not exist on type 'OnsiteProblemsChangedEvent'.
```

**根因**:I3 (c85e84b) 把 `OnsiteServerEvent` 改成 3-arm discriminated union:
- `OnsiteProblemsChangedEvent`(无 type,有 problems/problemId)
- `OnsiteProblemStateChangedEvent`(无 type,有 payload)
- `OnsiteChatFrame`(有 type / payload)

`OnsiteWebSocketContext.tsx:145-169` 的 `handleServerEvent` switch case:
- 之前默认所有事件都有 `event.type === 'problems:changed' | 'problem:<id>:state-changed'`
- 现在 chat 帧没 type,union access `.type` 在 narrow 之前 fail

**修复方案** — 在 dispatch 前 narrow:
```ts
// 区分 "control event" (有 type) vs "chat frame" (没 type,有 kind)
function isControlEvent(ev: OnsiteServerEvent): ev is OnsiteProblemsChangedEvent | OnsiteProblemStateChangedEvent {
  // 控制事件由 server 通过 type: 字段发(原协议)
  return 'type' in ev && typeof (ev as { type: unknown }).type === 'string';
}
```

或者:
```ts
// 在 OnsiteServerEvent 顶层加 discriminator
type OnsiteServerEvent = OnsiteChatFrame | (OnsiteProblemsChangedEvent | OnsiteProblemStateChangedEvent & { _tag: 'control' });
```

**选方案**:在 `OnsiteWebSocketContext.tsx:145-169` 加 type guard `isControlEvent`(改动小,影响面仅一个文件),**不改 shared types**。

读 `src/contexts/OnsiteWebSocketContext.tsx:145-169` 实际代码,选最干净的 fix。

**验证**:
```bash
npx tsc --noEmit -p tsconfig.json
# 期望 exit 0
```

### C2 — validate-no-hardcoded-customers.sh:82 EXCLUDE_KEYWORDS_REGEX 误伤

**症状**:`EXCLUDE_KEYWORDS_REGEX` 用 substring `test`,所以 `src/components/onsite-analysis/test-violation.tsx` 这种 violation probe 文件被排除,违反路径不会触发 exit 1。

**修复方案** — 把 substring 改成 path-segment 匹配:

```bash
# 旧(错):
EXCLUDE_KEYWORDS_REGEX="(test|spec|fixture|README|CLAUDE|\\.md|node_modules|dist)"

# 新(对):
EXCLUDE_PATH_REGEX='(^|/)(__tests__|tests?/|\.test\.|\.spec\.|node_modules|dist|fixtures?/)'
EXCLUDE_FILE_REGEX='(README\.md|CLAUDE\.md)$'
```

或者直接 path-component:
- `*/tests/*` / `*.test.*` / `*.spec.*` / `__tests__/*` / `node_modules/*` / `dist/*` / `*/fixtures/*`
- 文件名:`README.md` / `CLAUDE.md`(末尾)

**验证**(真正 probe):
```bash
mkdir -p src/components/onsite-analysis
echo "请选择客户" > src/components/onsite-analysis/violation-probe.tsx
./scripts/validate-no-hardcoded-customers.sh
echo "exit code: $?"  # 应 1
rm src/components/onsite-analysis/violation-probe.tsx
./scripts/validate-no-hardcoded-customers.sh
echo "exit code: $?"  # 应 0
```

**重要**:之前我(implementer + 我)在 brief 里用 `test-violation.tsx` 作 probe —— 这个 probe 永远 bypass 不会 catch,所以看似"测试通过"实际是 false negative。**C2 修完必须用一个非 test 字眼的 probe 文件名**(`violation-probe.tsx`)。

## 范围(必清)

只动 2 个文件:
- `src/contexts/OnsiteWebSocketContext.tsx`(C1)
- `scripts/validate-no-hardcoded-customers.sh`(C2)

## 验证

```bash
npx tsc --noEmit -p tsconfig.json
echo $?  # 期望 0

# C1 残留检查
grep -n "error TS" <(npx tsc --noEmit -p tsconfig.json 2>&1)
# 期望:空

# C2 真实跑
./scripts/validate-no-hardcoded-customers.sh
echo $?  # 期望 0

mkdir -p src/components/onsite-analysis
echo "请选择客户" > src/components/onsite-analysis/violation-probe.tsx
./scripts/validate-no-hardcoded-customers.sh
echo $?  # 期望 1
rm src/components/onsite-analysis/violation-probe.tsx
./scripts/validate-no-hardcoded-customers.sh
echo $?  # 期望 0
```

## 红线

- 不动 5 个 chat path 文件
- 不动 shared/onsite-types.ts(I3 已经锁)
- 不动 `server/claude-sdk.js`
- 不引入新 npm 包
- 2 commit(C1 一个,C2 一个),不 batch

## 报告

写 `/Users/xylink/ai/xy-claudecodeui/.superpowers/sdd/reports/batch8-fix1-report.md`:
- Status
- Files modified
- 2 commit hashes + messages
- tsc + validate 输出
- C1 选用的 type guard 代码片段
- C2 EXCLUDE 正则

回 5 行状态摘要。
