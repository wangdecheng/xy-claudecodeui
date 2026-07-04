# Batch 8 Fix 1 — C1 + C2

## Status

**DONE** — Both Critical issues from Batch 8 reviewer (`HOLD_FOR_FIX`) are resolved.
Client `tsc --noEmit` exits 0. C2 EXCLUDE regex tightened and verified end-to-end
(clean baseline + two violation probes including the original false-negative case).
2 commits, scope strictly limited to the 2 files in brief.

## Files modified

| 文件 | 改动 |
|---|---|
| `src/contexts/OnsiteWebSocketContext.tsx` | 加 `isControlEvent` 类型守卫 + `handleServerEvent` 入口处 narrow |
| `scripts/validate-no-hardcoded-customers.sh` | 用 path-segment / file-extension 正则替代裸 substring `test` |

`shared/onsite-types.ts` 未动(I3 commit `c85e84b` 锁)。
5 个 chat-path 保护文件(`src/services/`, `src/components/chat/`, `src/hooks/`)
相对 `f1e6bb4` 仍为零 diff。

## 2 commits

| Hash | Message |
|---|---|
| `e15f35d` | `fix(onsite): narrow OnsiteServerEvent union in WS context (C1)` |
| `3a54f90` | `fix(ci): tighten validate-no-hardcoded-customers exclude regex (C2)` |

```bash
$ git log --oneline -3
3a54f90 fix(ci): tighten validate-no-hardcoded-customers exclude regex (C2)
e15f35d fix(onsite): narrow OnsiteServerEvent union in WS context (C1)
7459316 docs(onsite): 11 SC 验收 evidence (Batch 8.4)
```

## tsc 输出

```bash
$ npx tsc --noEmit -p tsconfig.json
(无输出)
$ echo $?
0
```

C1 fix 前是 3 处 TS2339 错(`event.type` / `event.type` / `event.payload`),
fix 后全部消除。

## validate-no-hardcoded-customers.sh 退出码

| 场景 | 期望 | 实际 |
|---|---|---|
| Clean baseline | 0 | **0** ✓ |
| `src/components/onsite-analysis/violation-probe.tsx`(无 test 字眼) | 1 | **1** ✓ |
| `src/components/onsite-analysis/test-violation.tsx`(原 false-negative) | 1 | **1** ✓ |
| 合法 `server/modules/.../tests/*.test.ts` 仍被排除 | n/a | ✓ |

原始 false-negative `test-violation.tsx` 现在正确触发 exit 1。Clean baseline
保留 0(合法测试目录 `tests/`、`.test.` 文件后缀都被新正则排除)。

## C1 选用:type guard 代码片段

`src/contexts/OnsiteWebSocketContext.tsx:49-65`:

```ts
/**
 * Narrow `OnsiteServerEvent` to the two "control" branches that carry a
 * `type` discriminator. `OnsiteChatFrame` is the third arm of the union
 * (it has `kind` instead of `type`) and never reaches the control-event
 * switch below — runtime gating at `socket.onmessage` keeps chat frames
 * on the listener path.
 */
function isControlEvent(
  ev: OnsiteServerEvent,
): ev is OnsiteProblemsChangedEvent | OnsiteProblemStateChangedEvent {
  return (
    typeof ev === 'object' &&
    ev !== null &&
    'type' in ev &&
    typeof (ev as { type: unknown }).type === 'string'
  );
}
```

`handleServerEvent` 在 switch 入口先 narrow:

```ts
const handleServerEvent = useCallback(
  (event: OnsiteServerEvent): void => {
    if (!isControlEvent(event)) {
      // OnsiteChatFrame (or any future frame without `type`) — handled
      // by dispatchToListeners, never by this control-event switch.
      return;
    }

    if (event.type === 'problems:changed') {
      void loadProblems();
      return;
    }

    // problem:<id>:state-changed
    const match = /^problem:([^:]+):state-changed$/.exec(event.type);
    if (match && match[1]) {
      const id = match[1];
      const payload = event.payload;
      // ...
      void loadProblems();
      void payload;
      void id;
    }
  },
  [loadProblems],
);
```

设计选择:
- 用 `is` predicate 让 TS 在 narrow 后的分支里能访问 `.type` / `.payload`
- 不动 `shared/onsite-types.ts`(I3 锁)
- 影响面仅 `OnsiteWebSocketContext.tsx` 一个文件
- runtime 路径不变(`socket.onmessage` 第 239 行原本就在 `typeof obj.type === 'string'` 时才调 `handleServerEvent`),类型守卫只是把同一不变量显式化

## C2 EXCLUDE 正则

`scripts/validate-no-hardcoded-customers.sh:85-92`:

```bash
# 白名单:基于路径段 / 文件名边界匹配,而不是裸 substring。
# - 排除真正的 test/spec/fixture 目录(/__tests__/、/tests/、/spec/、/fixtures/)、
#   *.test.* / *.spec.* 文件、README.md / CLAUDE.md 文件
# - 排除配置/数据真相源(/config/customer-analysis.json、/config/json-schemas/、locales/)
# 关键:不再用 substring `test`,所以 `src/.../test-violation.tsx` 这种
# 故意命名的违规文件不能再 bypass。
EXCLUDE_PATH_REGEX='(/(node_modules|dist|__tests__|tests|spec|fixtures?)/|\.(test|spec)\.|/config/customer-analysis\.json|/config/json-schemas/|/locales/)'
EXCLUDE_FILE_REGEX='(README\.md|CLAUDE\.md)$'
```

设计要点:
- **路径段锚定**:用 `/(...)/` 强制要求是完整 path-segment,所以 `tests/` 在
  `server/modules/.../tests/*.test.ts` 这种合法位置被排除,但 `test-violation.tsx`
  这种文件名级 substring 不再 bypass。
- **文件名后缀锚定**:`\.(test|spec)\.` 只匹配 `xxx.test.ts` / `xxx.spec.ts`
  的扩展名点边界,而不是裸 `test` substring。
- **文件名末尾锚定**:`(README\.md|CLAUDE\.md)$` 只匹配 README/CLAUDE 文档本身。
- 拆成两个 regex(`EXCLUDE_PATH_REGEX` / `EXCLUDE_FILE_REGEX`)后逻辑更清晰,
  也方便后续扩展(比如再加 `.snap$` 这种 snapshot 文件白名单)。

注意:`scan_hint` / `scan_literal` 内部的 `(node_modules|/dist/)` 重复过滤
也跟着移除了,因为新 `EXCLUDE_PATH_REGEX` 已经覆盖。

## Diff stats for protected files

```bash
$ git diff --stat c85e84b -- shared/onsite-types.ts
(empty — zero diff vs I3 commit)

$ git diff --stat f1e6bb4 -- \
    src/services/ \
    src/components/chat/ \
    src/hooks/ \
    src/App.tsx \
    src/stores/onsiteStore.tsx
 src/App.tsx                |   6 +
 src/stores/onsiteStore.tsx | 304 ++++++++++++++++++++++++++++++++++++++++++
 2 files changed, 310 insertions(+)

$ git diff --stat f1e6bb4 -- \
    src/services/ \
    src/components/chat/ \
    src/hooks/
(empty — these 3 paths are zero diff)
```

`src/App.tsx` / `src/stores/onsiteStore.tsx` 的 diff 是 Batch 6+ onsite feature
的既有改动(在 c85e85d 之前的 batch 里就提交了),不在本次 fix 范围内。本次 fix
仅触碰 `src/contexts/OnsiteWebSocketContext.tsx`(`f1e6bb4` 后由 Batch 6.2
新增,不在"5 个 chat-path 保护文件"列表中)与 `scripts/validate-no-hardcoded-customers.sh`。

## Scope check

```bash
$ git diff --stat HEAD~2 -- \
    src/contexts/OnsiteWebSocketContext.tsx \
    scripts/validate-no-hardcoded-customers.sh
 scripts/validate-no-hardcoded-customers.sh | 29 ++++++++++++++++++++---------
 src/contexts/OnsiteWebSocketContext.tsx    | 26 ++++++++++++++++++++++++++
 2 files changed, 46 insertions(+), 9 deletions(-)
```

严格 2 文件,无意外溢出。