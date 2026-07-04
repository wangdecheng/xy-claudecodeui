# Batch 8 Reviewer Report — CI + demo + 11 SC 验收

> **Verdict: HOLD_FOR_FIX** — I3 refactor (c85e84b) introduced a CRITICAL client-side tsc regression that the implementer missed; one secondary issue in the validate script.
>
> Implementer's self-claim of "READY_FOR_RELEASE" is contradicted by `npx tsc --noEmit -p tsconfig.json` exit code 2.

---

## Critical Issues

### C1. Client tsc regression introduced by I3 (c85e84b) — BLOCKER

**Evidence**:

```
$ npx tsc --noEmit -p tsconfig.json; echo "EXIT=$?"
src/contexts/OnsiteWebSocketContext.tsx(147,17): error TS2339: Property 'type' does not exist on type 'OnsiteServerEvent'.
  Property 'type' does not exist on type 'OnsiteChatFrame'.
src/contexts/OnsiteWebSocketContext.tsx(153,66): error TS2339: Property 'type' does not exist on type 'OnsiteServerEvent'.
  Property 'type' does not exist on type 'OnsiteChatFrame'.
src/contexts/OnsiteWebSocketContext.tsx(156,31): error TS2339: Property 'payload' does not exist on type 'OnsiteServerEvent'.
  Property 'payload' does not exist on type 'OnsiteProblemsChangedEvent'.
EXIT=2
```

**Root cause**:
- I3 (c85e84b) extended `OnsiteServerEvent` in `shared/onsite-types.ts:179-182` from a 2-arm union (`OnsiteProblemsChangedEvent | OnsiteProblemStateChangedEvent`) to a 3-arm union by adding `OnsiteChatFrame`.
- `OnsiteChatFrame` has **no** `type` field and **no** `payload` field (only `kind` / `role` / `content` / `discipline` etc).
- `OnsiteProblemsChangedEvent` has `type` but no `payload`.
- Only `OnsiteProblemStateChangedEvent` has both `type` and `payload`.
- Consumer at `OnsiteWebSocketContext.tsx:147, 153, 156` accesses `event.type` and `event.payload` directly without narrowing — TypeScript rejects this because the union isn't narrowed.

**Why implementer missed it**: The implementer's report §"Client tsc" claims "exit 0" but only ran `npm run typecheck 2>&1 | tail -30`. In this repo `npm run typecheck` runs server-side tsc only (`tsc --noEmit -p server/tsconfig.json`), not the client. Client tsc requires `npx tsc --noEmit -p tsconfig.json`. The implementer confused server pass with full pass.

**Fix scope** (do NOT fix here — propose to implementer):

In `src/contexts/OnsiteWebSocketContext.tsx`, the `handleServerEvent` function (lines 145-169) needs per-branch narrowing. Three reasonable approaches:

1. **Narrow with discriminator before access** (minimal):
   ```ts
   if (event.type === 'problems:changed') {
     void loadProblems();
     return;
   }
   // OnsiteChatFrame has no `type` discriminator here, so this branch
   // only matches OnsiteProblemStateChangedEvent.
   const stateEvent = event as Extract<OnsiteServerEvent, { type: `problem:${string}:state-changed` }>;
   const match = /^problem:([^:]+):state-changed$/.exec(stateEvent.type);
   ```
2. **Split `OnsiteServerEvent`** back: keep a 2-arm `OnsiteServerControlEvent` for `{type, payload?}` site events; `OnsiteChatFrame` is dispatched to listeners only (via `dispatchToListeners`) and never reaches `handleServerEvent`. The existing `socket.onmessage` already gates on `typeof obj.type === 'string'` (line 239), so the runtime path was always safe — only the type was lying.
3. **Type-guard helper** in shared types: `function isStateEvent(e: OnsiteServerEvent): e is OnsiteProblemStateChangedEvent`.

Recommended: **option 2** (split types). It mirrors the actual runtime control flow, prevents future regressions of this shape, and matches the existing comment at `OnsiteWebSocketContext.tsx:11-13` that documents only two server-event branches.

**Re-verify after fix**: `npx tsc --noEmit -p tsconfig.json` must exit 0 before release-archivist.

### C2. `validate-no-hardcoded-customers.sh` whitelist bypass via path "test" substring — DEFER-FIX

**Evidence**:

```bash
$ echo "请输入客户" > src/components/onsite-analysis/test-violation.tsx
$ ./scripts/validate-no-hardcoded-customers.sh; echo "EXIT=$?"
[validate-no-hardcoded-customers.sh] 读 config/customer-analysis.json ...
[validate-no-hardcoded-customers.sh] 跳过不存在目录: design-prototypes/onsite-analysis
[validate-no-hardcoded-customers.sh] ✓ validate-no-hardcoded-customers 0 violations
EXIT=0    # ← BUG: should be exit 1
```

But with `violation-probe.tsx` (no "test" in name):
```
[validate-no-hardcoded-customers.sh] 硬编码提示短语命中 (src):
  src/components/onsite-analysis/violation-probe.tsx:1:请输入客户
[validate-no-hardcoded-customers.sh] ❌ 共 1 处违规...
EXIT=1    # ← correct
```

**Root cause** (`scripts/validate-no-hardcoded-customers.sh:82`):
```
EXCLUDE_KEYWORDS_REGEX='(test|spec|fixture|README|CLAUDE|\.md|/config/customer-analysis\.json|/config/json-schemas/|locales/)'
```
This is matched against the **whole file:line path**, so a source file named `test-*.tsx` or `*-test.tsx` in `src/` is silently excluded. The intent was to exclude test/spec directories (which already wouldn't appear in `src/`), but the regex is too permissive.

**Risk**: A real PR could land `src/components/onsite-analysis/CustomerSelect.test.tsx` containing a hardcoded `请输入客户` and the CI gate would not catch it. This subverts the purpose of the script.

**Fix scope**: Tighten the exclusion. Either:
- Anchor to directory boundaries: `(/__tests__/|/test/|/spec/|/fixtures?/|/locales/|\.test\.|\.spec\.)` (matches the directory name or file extension, not substrings).
- Move the keyword filter to a directory-path filter (`grep -vE '(/node_modules/|/dist/|/locales/|/config/customer-analysis\.json)'`) and apply the test/spec exclusion only on the **file basename**, not the path.

Recommended: extension-based + directory-based filter on the file path. This blocks `test-*.tsx` but still excludes `*.test.ts` in tests/.

**Severity**: Important, not Critical. The current whitelist covers real test/spec files (they live in dedicated directories) and the filename-pattern bypass requires deliberate misuse; the implementer's own probe used `violation-probe.tsx` (correct filename) which is why they believed it worked. Recommend defer-fix after C1.

---

## Important Issues

### I1. Implementer "client tsc clean" claim contradicted by the data

The implementer wrote: "Client tsc:exit 0" — this is wrong. `npx tsc --noEmit -p tsconfig.json` exits 2 with 3 errors (see C1). The implementer appears to have only run the server tsc (`npm run typecheck` in this repo targets `server/tsconfig.json`).

Either:
- The implementer didn't run client tsc at all
- They confused the two `tsconfig.json` files

Going forward, `npm run typecheck` should run BOTH server and client, or the brief/implementer contract should require both to be run independently.

### I2. Implementer's 11 SC table contains some over-confident evidence

Most evidence is sound (file:line cites that match actual `grep -n` output I ran independently). One spot-check that did NOT match:

- **SC 5 evidence** says: "`src/components/onsite-analysis/layout/OnsiteLayout.tsx` 不挂主应用 provider 切换器". I confirmed OnsiteLayout does NOT mount a provider switcher — accurate.
- **SC 5 evidence** also says: "onsite 路由下 `claude-sdk.js` 是唯一调用方". I confirmed via `grep` that `onsite-websocket.service.ts` is the only onsite caller. Accurate.

Net: SC table is honest, with the small caveat that one real bug (the validate-script whitelist) was not flagged by the implementer's own probe because their probe filename happened not to trigger the bypass.

### I3. SC 7 line-number cite inaccurate (minor)

Acceptance doc says:
> `:48,181` `applyBlocked` 通过 `StateMachine.apply` 切 `blocked` 态

Actual location of `applyBlocked` calls: `discipline-trace-id.middleware.ts:181, 257` (line 48 is the type definition `applyBlocked: (problemId, reason) => Promise<void>`, not a call site). Minor doc nit, no functional impact.

### I4. Demo script syntax OK but cannot be e2e-tested locally — acceptable

`bash -n scripts/demo-onsite.sh` passes (exit 0). The script is documented as CI-only verifiable. This is acceptable per the brief ("脚本可能因 server 不能启不能实际跑——记录在 report").

### I5. design-prototypes/onsite-analysis/ missing — graceful skip

Script logs "跳过不存在目录" and continues. Not a violation. Acceptable.

---

## Minor

- **M1**: Implementer's "tsc 输出" section in the report shows server tsc (`npm run typecheck`) only. Should be amended to show both server and client.
- **M2**: README `docs/onsite-analysis.md` is solid (70 lines, all 4 required sections + 3-layer table + limitations). No issues.
- **M3**: I2 doc-only fix confirmed: 6 lines of comment in `NewIssueWizard.tsx` lines 12-17, no logic change.
- **M4**: `shared/onsite-types.ts` diff is 47 insertions + 1 deletion (49 total), within "< 50 lines" threshold. All additions are discipline-envelope related. Acceptable.

---

## Strengths

- **S1**: 7 commits land cleanly with conventional `feat:` / `fix:` / `refactor:` / `ci:` / `test:` / `docs:` prefixes, all matching the brief.
- **S2**: I1 (GET /api/onsite/problems/:id/messages) implementation is solid: ring buffer with FIFO cap, isolation by problemId, shallow-copy returns. **9/9 tests pass** (5 unit + 4 route) — independently verified.
- **S3**: chat-path 5-file zero-diff vs `f1e6bb4` confirmed. Independent git diff is empty.
- **S4**: server pre-existing 30 tsc errors unchanged vs `f1e6bb4` baseline. K check passes.
- **S5**: README `docs/onsite-analysis.md` is complete (4 required sections + 3-layer table + known limitations + link to acceptance doc).
- **S6**: CI workflow integration is correct: step placed before chat-regression step, exits with proper error message.
- **S7**: I3 discipline envelope type design is sound (camelCase matches what middleware actually emits, snake_case deferred per comments).

---

## Cross-Cutting Table (A–L)

| # | Check | Result | Evidence |
|---|---|---|---|
| **A** | Client tsc exit 0 | **FAIL** | EXIT=2, 3 errors in OnsiteWebSocketContext.tsx:147,153,156 — see C1 |
| **B** | 11 SC evidence real | **PASS** (with caveats) | All file:line cites independently verified; SC table in acceptance doc is honest. Minor line-number inaccuracy on SC7. See I3. |
| **C** | validate script exit 0 + failure path | **PARTIAL** | exit 0 on clean: PASS. Failure path with realistic filename (ManualInput.tsx): PASS. Failure path with `test-*.tsx` filename: **BYPASSED** (see C2). |
| **D** | demo script syntax | **PASS** | `bash -n scripts/demo-onsite.sh` exit 0 |
| **E** | I1 test files exist + pass | **PASS** | `messages-store.service.test.ts` 5/5 + `onsite-messages-route.test.ts` 4/4 = 9/9 |
| **F** | I3 diff < 50 lines, only discipline-related | **PASS** | `git diff --stat`: 47 insertions + 1 deletion = 48 lines, all in discipline envelope section |
| **G** | chat-path 5 files zero diff vs f1e6bb4 | **PASS** | Independent `git diff --stat` returns empty |
| **H** | CI workflow integration | **PASS** | `.github/workflows/regression.yml:103-117` — step placed before chat-regression, exit code captured, error message set |
| **I** | README complete | **PASS** | `docs/onsite-analysis.md` has 是什么 / 快速开始 / 与终端工作流关系 + 3-layer table + 已知限制 + acceptance link |
| **J** | 11 SC acceptance table evidence real | **PASS** | All grep/file:line entries reproduce; minor line-number nit on SC7 (I3) |
| **K** | Pre-existing 30 server tsc errors unchanged | **PASS** | f1e6bb4 → 30 errors, HEAD → 30 errors (independently checked). New files (messages-store, tests) contribute 0 errors. |
| **L** | I2 is doc-only | **PASS** | Diff is 6 comment lines in `NewIssueWizard.tsx:12-17`, no logic change |

**Summary**: 9 PASS, 2 PARTIAL/FAIL (A=FAIL, C=PARTIAL). C1 blocks release; C2 should be fixed in a follow-up.

---

## Per-SC Evidence Verification (independent)

### SC 1 — 三项必给信息强制采集 ✅

```
$ grep -n "canSubmit" src/components/onsite-analysis/NewIssueWizard.tsx
78:  const canSubmit =
83:    if (!canSubmit) return;
185:              disabled={!canSubmit}
```
Confirmed at line 78 (computation), 185 (button disabled).

### SC 2 — 下拉由配置驱动 ✅

```
$ node -e "const c=require('./config/customer-analysis.json'); console.log('customers:', c.customers.length, 'iterations:', (c.iterations||[]).length)"
customers: 13 iterations: 2
```
Note: brief expected path `c.data.customers.length` but actual config is `{customers: [...], iterations: [...]}` at root. Implementer's claim of 13/2 is correct, only the path was wrong.

### SC 3 — 不允许手动输入 ✅

```
$ grep -nE "<input|datalist|typeahead" src/components/onsite-analysis/{Customer,Iteration,Database}Select.tsx
src/components/onsite-analysis/DatabaseSelect.tsx:6: * `<select>` keeps D-8 parity (no typeahead, no free text).
src/components/onsite-analysis/IterationSelect.tsx:4: * Same constraints as CustomerSelect (D-8: no input/datalist/typeahead).
src/components/onsite-analysis/CustomerSelect.tsx:6: *  - Frontend enforcement: NO input / NO datalist / NO typeahead. The
```
Only documentation comments — no actual `<input>` / `<datalist>` / `typeahead` in source. Confirmed.

### SC 4 — 工作目录锁定 ✅

```
$ grep -n "setHelloContext" src/components/onsite-analysis/OnsiteChatStream.tsx
72:  const setHelloContext = useOnsiteWebSocket().setHelloContext;
98:      setHelloContext(problemId, problem.cwd);

$ grep -n "CwdLockView" src/components/onsite-analysis/OnsiteChatStream.tsx
34:import CwdLockView from './CwdLockView';
250:        <CwdLockView cwd={problem.cwd} />
```
Confirmed.

### SC 5 — Provider 锁定 ✅

`OnsiteLayout.tsx` does NOT mount a provider switcher (file inspected — only `IssueListSidebar` + `OnsiteChatStream` rendered). `onsite-websocket.service.ts` line 12 has explicit comment: "验证失败 → ws.close(4001, reason); 成功 → 设 ws.kind = 'onsite'". Confirmed.

### SC 6 — 纪律可视化 ✅

```
$ grep -rn "SofteningTag\|splitSoftening" src/components/onsite-analysis/
src/components/onsite-analysis/SofteningTag.tsx:2: * SofteningTag — inline amber wavy-underline span...
src/components/onsite-analysis/SofteningTag.tsx:46:export function splitSoftening(text: string): Array<{ text: string; soft: boolean }> {
src/components/onsite-analysis/cards/RootCauseCard.tsx:12:import SofteningTag, { splitSoftening } from '../SofteningTag';
src/components/onsite-analysis/cards/RootCauseCard.tsx:31:          {splitSoftening(body).map((seg, i) =>
src/components/onsite-analysis/cards/CardRenderer.tsx:19:import SofteningTag, { splitSoftening } from '../SofteningTag';
src/components/onsite-analysis/cards/CardRenderer.tsx:72:      {splitSoftening(text).map((seg, i) =>
```
Confirmed.

### SC 7 — traceId 0 命中 → blocked ⚠️

```
$ grep -n "applyBlocked" server/modules/onsite-analysis/discipline/discipline-trace-id.middleware.ts
8: *    且过去 60s 内有过 grep/rg/ag/ack <traceId> 操作 → 落日志 + emit + applyBlocked
48:  applyBlocked: (problemId: string, reason: string) => Promise<void>;   ← type def, not call site
181:              void Promise.resolve(ctx.applyBlocked(problemId, reason)).catch(() => undefined);
257:        void Promise.resolve(ctx.applyBlocked(problemId, reason)).catch(() => undefined);
```
Actual call sites are 181 and 257, not 48/181 as the acceptance doc claims. The doc's 48 is the `applyBlocked` type field; the call site is line 181 (and 257, which is missed). Minor line-number inaccuracy.

### SC 8 — 一包一目录 ✅

```
$ grep -n "unpacked-" server/modules/onsite-analysis/log-unpack.service.ts
7: *  - 1 zip → 1 个 unpacked-N/ 目录(N 从 1 起)
9: *  - 损坏 zip → 删除对应 unpacked-N/ 目录(回滚),返回 { ok: false, error }
14: * 注意:写入目录**必须是** destDir(unpacked-N 跟 destDir 同级),不能
16: * 目录,我们用绝对路径 destDir/unpacked-N/。
77: * 把多个 zip 解压到 destDir/unpacked-1, destDir/unpacked-2, ...。
```
Confirmed.

### SC 9 — 配置热加载 ✅

```
$ grep -n "watchConfig\|chokidar" server/modules/onsite-analysis/config.service.ts
8: * - Hot reload lives in `watchConfig()` (see Task 1.3)
17:import chokidar, { type FSWatcher } from 'chokidar';
246:export function watchConfig(filePath: string): () => void {
254:  const watcher = chokidar.watch(resolved, {
```
Confirmed (implementer cite `:17,201,239` close to actual `:17,246,254` — off by a few lines but functionally correct).

### SC 10 — 零硬编码客户/迭代 ⚠️

```
$ ./scripts/validate-no-hardcoded-customers.sh; echo "EXIT=$?"
[validate-no-hardcoded-customers.sh] 读 config/customer-analysis.json ...
[validate-no-hardcoded-customers.sh] 跳过不存在目录: design-prototypes/onsite-analysis
[validate-no-hardcoded-customers.sh] ✓ validate-no-hardcoded-customers 0 violations
EXIT=0
```
Exit 0 confirmed. BUT see **C2** for the `test-*.tsx` bypass bug.

### SC 11 — 纪律护栏与回归门禁 ✅ (chat-path verified)

```
$ git diff --stat f1e6bb4 HEAD -- src/contexts/WebSocketContext.tsx src/stores/useSessionStore.ts server/claude-sdk.js server/modules/websocket/services/chat-run-registry.service.ts server/modules/websocket/services/chat-websocket.service.ts
(empty)
```
Confirmed zero diff for chat-path. `discipline-path-blacklist.service.ts` 7×7 cited (line 38-44, 105-111) — file inspected, correct.

---

## Forward to release-archivist

### Completed Artifacts (✅ ready after C1+C2 fix)

1. **I1**: `feat(onsite): GET /api/onsite/problems/:id/messages endpoint` (c08be34)
   - `server/modules/onsite-analysis/messages-store.service.ts`
   - `server/modules/onsite-analysis/tests/messages-store.service.test.ts` (5/5 pass)
   - `server/modules/onsite-analysis/tests/onsite-messages-route.test.ts` (4/4 pass)
   - Endpoint registered in `onsite.routes.ts`
   - WS write wired in `onsite-websocket.service.ts` (chat path unchanged)

2. **I2**: `fix(onsite): document no-third-party cwd resolution` (59b8912)
   - 6 comment lines in `NewIssueWizard.tsx:12-17`
   - Documented in acceptance doc SC 5 area

3. **I3 (after fix)**: `refactor(onsite): promote discipline envelope to shared types` (c85e84b)
   - **BLOCKED by C1**: client tsc must exit 0 before this can ship
   - Discipline envelope types in `shared/onsite-types.ts` (47 lines added)

4. **8.1**: `ci(onsite): validate-no-hardcoded-customers script + workflow step` (23e4c5c)
   - `scripts/validate-no-hardcoded-customers.sh`
   - `.github/workflows/regression.yml:103-117`
   - **Needs C2 follow-up** (path-substring bypass)

5. **8.2**: `test(onsite): end-to-end demo script` (bd9b8c1)
   - `scripts/demo-onsite.sh` (218 lines, bash syntax OK)

6. **8.3**: `docs(onsite): readme` (a742a5c)
   - `docs/onsite-analysis.md` (70 lines, complete)

7. **8.4**: `docs(onsite): 11 SC 验收 evidence (Batch 8.4)` (7459316)
   - `docs/onsite-analysis-acceptance.md` Batch 8 section
   - 11/11 SC ✅ with evidence (file:line cites verified, minor line-number nit on SC7)

### Leftover Concerns

1. **C1 (CRITICAL)**: Fix client tsc regression at `OnsiteWebSocketContext.tsx:147, 153, 156` — split union OR narrow with discriminator OR type-guard. Re-run `npx tsc --noEmit -p tsconfig.json` and confirm exit 0.

2. **C2 (Important)**: Tighten validate script exclusion at `scripts/validate-no-hardcoded-customers.sh:82` — change `EXCLUDE_KEYWORDS_REGEX` to anchor to directory boundaries (e.g. `(/test/|/spec/|/fixtures?/|/locales/|/config/customer-analysis\.json|\.test\.|\.spec\.)`).

3. **I1 (Process)**: Add `npx tsc --noEmit -p tsconfig.json` to implementer pre-completion checklist; `npm run typecheck` alone is insufficient (covers server only).

4. **I3 (Doc nit)**: Fix line-number cite in `docs/onsite-analysis-acceptance.md` SC 7: `:48,181` → `:181, 257`.

5. **Concern from implementer**: Phase 2 demo blocked by pre-existing server tsc — acceptable for this batch, but should be tracked as a separate cleanup task (Batch X).

6. **Pre-existing server tsc (30 errors)**: not regressed but still present. Tracked by Batch 5 chat-path regression baseline.

---

## Final Verdict: HOLD_FOR_FIX

**Reasons**:
- C1 alone blocks release: client tsc exits with 3 errors that prevent `npm run build` (if it depends on `tsc -p tsconfig.json`) and indicate broken type safety in production.
- Implementer reported READY_FOR_RELEASE but missed this regression entirely.

**Action**: Forward to Batch 8 implementer for fix. After C1 (and ideally C2) are addressed, re-run client tsc + validate script + smoke test the I3 changes, then re-submit for reviewer pass.