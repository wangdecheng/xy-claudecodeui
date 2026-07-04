# Batch 7 Reviewer Report — 前端页面 + 卡片 + 纪律 UI

**Verdict: HOLD_FOR_FIX**

One Critical bug (DisciplineCounter renders hardcoded "0" — the wire counter never reaches the UI; the OnsiteChatStream side tally is dead state). All other gates are clean. See "Critical issues" below.

## Critical issues (1)

### C1. DisciplineCounter pills always display "0" — state architecture is broken

**File**: `/Users/xylink/ai/xy-claudecodeui/src/components/onsite-analysis/DisciplineCounter.tsx` lines 28-71 + `/Users/xylink/ai/xy-claudecodeui/src/components/onsite-analysis/OnsiteChatStream.tsx` lines 75, 107-112.

**Repro**:
```bash
$ grep -nE "setSoftCount|setWriteCount|softCount|writeCount" \
    src/components/onsite-analysis/DisciplineCounter.tsx
30:  const [softCount, setSoftCount] = useState(0);
31:  const [writeCount, setWriteCount] = useState(0);
38:  if (resetKey !== undefined && (resetKey as unknown) !== softCount) {
43:  void setSoftCount;
44:  void setWriteCount;
# No code actually increments softCount / writeCount / log.
# Display is hardcoded on lines 61 + 70:
61:        <span>{t(...,{defaultValue:'softening'}).slice(0,4)} 0</span>
70:        <span>logs 0</span>
```

**Symptom**: The header pills always read "soft... 0" / "logs 0" no matter how many softening words or writeOriginalLog events the server sends. The pill overlay (click-to-expand log) is always empty.

**Root cause**:
1. `DisciplineCounter` declares three `useState` slots (`softCount`, `writeCount`, `log`) that nothing ever writes to. The `void setSoftCount;` etc. on lines 43-45 are no-ops suppressing the unused-locals warning — the developer left them as a placeholder.
2. The real counter `DisciplineState` lives in `OnsiteChatStream` (line 75: `const [, setDiscipline] = useState(...)`), and that state IS bumped in the WS subscription callback (lines 109-112). But the destructure-throwaway `[, setDiscipline]` discards the read side — so the value is updated and immediately forgotten.
3. The two components are not connected: DisciplineCounter receives only `problemId` and `resetKey`, never any tally. The comment in DisciplineCounter line 36-41 admits the reset "is performed by the parent before this renders via the effect chain" — but no such effect exists.

**Fix direction (do NOT apply now — flag for fix-executor)**:
- Pick one source of truth: keep the tallies in OnsiteChatStream and pass them down to DisciplineCounter as props (`<DisciplineCounter softening={n} writeOriginalLog={m} ... />`), OR move subscription into DisciplineCounter itself and lift reset via the key.
- The envelope `discipline.softening === true` flag is read at OnsiteChatStream line 110-112; route the result to DisciplineCounter. The previously-discarded `[, setDiscipline]` should become `[discipline, setDiscipline]` and `discipline.softening`/`discipline.writeOriginalLog` should be passed to the pill as props.

The dev comment on line 38-41 is a code smell: a no-op conditional in render with `void` operators — that's not a reset, it's a stub.

## Important issues (3)

### I1. (defer to Batch 8) No GET /messages endpoint — message loss on reload

`OnsiteChatStream` keeps messages in `useState` (line 72) — closing the tab drops everything. The brief and implementer report already flag this (Open Q3). Not a Batch 7 fix; Batch 8 demo should pre-seed via WS-only flow.

### I2. (defer to Batch 8) Server `cwd` validation for no-third-party path

`NewIssueWizard.tsx` line 84: `cwd: matched?.branch ?? customer`. When `branch === null`, `cwd` is the customer label string. Server's `assertCwdUnderRoot` requires cwd under ONSITE_ROOT — customer labels may not satisfy that. Open Q1. Demo workaround: don't pick "no third-party" customer in Batch 8 demos.

### I3. Discipline envelope flag not in shared types

`OnsiteChatStream` lines 98, 107-112 read `ev.discipline` as `Record<string, unknown>` defensively. Batch 6's `OnsiteServerEvent` type does not formally declare the `discipline` field. Defensive reading is fine for Batch 7; flag for a future batch to promote `discipline.{softening,writeOriginalLog,traceIdSuspect}` into `shared/onsite-types.ts` so the type narrows and Q2 (implementer's open question) closes.

## Minor

### M1. DisciplineCounter renders "soft" instead of full word

Line 61: `{t(...).slice(0, 4)} 0` hardcodes truncation to first 4 chars. With `defaultValue: 'softening'`, that yields "soft 0". Cosmetic, but worth normalizing once C1 is fixed (the slice was an interim placeholder).

### M2. DisciplineCounter props `resetKey` is dead code

Lines 36-41 do nothing — `resetKey` is destructured but never wired into the actual reset logic (and the parent OnsiteChatStream already manages its own `setDiscipline({...0})` reset on problem switch line 91, separate from DisciplineCounter). Either remove `resetKey` or route real reset logic through it.

### M3. `OnsiteWebSocketContext` has unused `void` operators

Lines 162-164: `void payload; void id;` after the `problem:<id>:state-changed` branch. The handler just calls `loadProblems()` and discards payload — those `void` ops are stale code from prior scaffolding. Not blocking, but they call attention to a feature that was originally planned (per-problem optimistic patch) but was simplified to full reload.

### M4. SofteningTag client word list vs server authoritative list

`SofteningTag.tsx` line 29-32: client list is a hardcoded subset. Brief and implementer report both call this out (Open Q6). Acceptable because the server is the authoritative gate — but flag a future `GET /api/onsite/discipline-words` endpoint to keep client & server in sync.

### M5. Brief asked for `.msg.user` / `.msg.ai` className

Brief §D said: "find `.msg.user` / `.msg.ai` className or equivalent class". The implementation uses Tailwind utilities (`ml-auto ... bg-blue-500 ... text-white` for user, `mr-auto ... max-w-[80%]` for assistant) via `cn()` rather than explicit `.msg.user` / `.msg.ai` classNames. This is functionally equivalent and stable through Tailwind compilation, but a literal grep for `.msg.user` returns nothing — if Batch 8 static scanners use literal class names, they'll need an alternate pattern (e.g. `data-role="user"` attribute, or grep for `bg-blue-500` as the marker). Not blocking.

## Strengths

- **All 11 hard gates pass independently.** tsc=0, vite build clean, chat-path zero diff (f1e6bb4..HEAD), shared-types zero diff (cd901cc..HEAD), package.json zero diff, OnsiteNavButton mounted only at App root, three Selects are pure `<select>` with zero `<input>` / datalist / typeahead, zero camelCase field access, OnsiteChatStream and MessageBubble place user messages right-blue (`ml-auto bg-blue-500 text-white`) and assistant text left (`mr-auto whitespace-pre-wrap`), CardRenderer only invoked on assistant messages, SofteningTag uses amber-500 + `textDecorationStyle: 'wavy'`, RootCauseCard and CardRenderer both run text through `splitSoftening`.
- **Snake_case migration locked.** All field accesses in `src/components/onsite-analysis/` and `src/contexts/OnsiteWebSocketContext.tsx` use snake_case (verified: zero matches for `thirdBridgeBranch|problemJsonPath|rootCauseText|originalName|createdAt`). Shared types zero-diff since `cd901cc` means Batch 6's fix is intact.
- **OnsiteWebSocketContext.subscribe correctly scoped.** The listener registry is a closure-local `Set<OnsiteServerEventListener>`; only `onmessage` dispatches to it; chat-WS (`WebSocketContext.tsx`, `useSessionStore.ts`, `chat-run-registry.service.ts`, `chat-websocket.service.ts`, `claude-sdk.js`) is byte-identical to `f1e6bb4`.
- **NewIssueWizard: disabled logic correct.** `canSubmit = configOk && customer && iteration && database && !creating`; data-testid is `onsite-new-issue-wizard` (placeholder gone); no-third-party branch correctly omits `third_bridge_branch` field (line 87-89 `if (matched && matched.branch !== null)`).
- **CwdLockView: middle-ellipsis + title=full path.** `title={cwd}` always exposes the full path on hover; display path goes through `shortenCwd` (segment-preserving, last-segment kept).
- **LogUploader: 20-file & 200MB trim correct.** `MAX_FILES = 20`, `MAX_FILE_SIZE = 200MB` exported, per-file >200MB is dropped with a warning before the bulk 20-file cap is applied.
- **CardRenderer unknown-type fallback is graceful.** Unknown `<card type="X">` falls through to raw text via `renderText(<raw markup>, key)` instead of silently dropping content.
- **Batch 5.5 protected files (chat path) verified zero-diff.** Both `git diff f1e6bb4 HEAD -- ...` (5 files) and `git diff cd901cc HEAD -- shared/onsite-types.ts` return zero lines of diff.

## Cross-cutting verification table

| # | Check | Status | Evidence |
|---|---|---|---|
| A | Client `npx tsc --noEmit -p tsconfig.json` exit 0 | **PASS** | `EXIT=0`, silent |
| B1 | CustomerSelect / IterationSelect / DatabaseSelect pure `<select>` (D-8) | **PASS** | `grep -nE "<input\|datalist\|typeahead\|autoComplete\|onInput"` returns only comments mentioning the constraint; `<input` returns zero lines; each file has exactly one `<select ...>` |
| B2 | Zero camelCase field names (`thirdBridgeBranch`, etc.) in frontend onshore + WS context | **PASS** | `grep -rnE "thirdBridgeBranch\|problemJsonPath\|rootCauseText\|originalName\|createdAt" src/components/onsite-analysis/`: zero matches; same on OnsiteWebSocketContext: zero matches |
| B3 | `OnsiteNavButton` not re-mounted in `OnsiteLayout.tsx` | **PASS** | `grep "OnsiteNavButton" src/components/onsite-analysis/layout/OnsiteLayout.tsx`: zero; mounted only at `src/components/app/AppContent.tsx:200` |
| C | Wizard 3-required + no-third-party branch + placeholder replaced | **PASS** | `canSubmit` requires all 3 + configOk; line 87-89 omits `third_bridge_branch` when branch===null; data-testid is `onsite-new-issue-wizard` (no `data-testid="onsite-layout-placeholder"`) |
| D | User right-blue bubble / AI left plain | **PARTIAL_PASS** (function correct, naming uses Tailwind not literal `.msg.user`/`.msg.ai`) | MessageBubble lines 286-294: user → `ml-auto max-w-[80%] bg-blue-500 text-white`; assistant → `mr-auto max-w-[80%] whitespace-pre-wrap`. CardRenderer (line 303) only invoked on assistant text. See M5 |
| E | SofteningTag amber + wavy underline + `splitSoftening` exported, used by RootCauseCard & CardRenderer | **PASS** | SofteningTag lines 73-83: `text-amber-600` + inline `textDecoration: 'underline', textDecorationStyle: 'wavy'`; `splitSoftening` exported (line 46); used by RootCauseCard line 31 and CardRenderer line 72 |
| F | DisciplineCounter two pills + envelope tally + `resetKey` | **FAIL** | Pills render hardcoded ` 0` / `logs 0` (lines 61, 70); no code writes to `setSoftCount/setWriteCount/setLog`; the parent's `setDiscipline` is destructured-throwaway (`[, setDiscipline]` line 75); tally never reaches UI. See C1 |
| G | Chat-path zero diff vs f1e6bb4 (5 files) | **PASS** | `git diff f1e6bb4 HEAD -- <5 files>` : 0 lines |
| H | `shared/onsite-types.ts` zero diff vs cd901cc | **PASS** | `git diff cd901cc HEAD -- shared/onsite-types.ts` : 0 lines |
| I | No new npm packages | **PASS** | `git diff HEAD~4 HEAD -- package.json package-lock.json`: 0 lines |
| J | `npx vite build` clean (exit 0) | **PASS** | `EXIT=0`, dist/assets regenerated with `index-DeqCftBe.js` |
| K | `OnsiteWebSocketContext.subscribe` doesn't pollute chat WS | **PASS** | Closure-local listenersRef + Set; onmessage dispatches to `handleServerEvent` (type field) and `dispatchToListeners` (raw obj); no chat files touched; no fallback routing of chat-kind events |
| L | Open Q1-Q6 handling | **PASS** (matches pre-approved positions) | Q1, Q3 defer to Batch 8 (see I1, I2); Q2 (I3), Q5 (overlap with C1), Q4, Q6 are minor as briefed |

## Forward compatibility for Batch 8

1. **Demo script must seed messages via WS, not GET.** Since `/api/onsite/problems/:id/messages` doesn't exist, the chat panel will be empty after a page refresh. For Batch 8 demo, keep the panel open or send messages in the same session.

2. **Don't demo "no third-party" customer in current cwd-validation setup.** Wizard sends `cwd = customer` for `branch === null` (NewIssueWizard line 84), which the server's `assertCwdUnderRoot` may reject. Workaround for demo: use a customer whose branch is set.

3. **DisciplineCounter header pill will read "0" until C1 is fixed.** Demo scripts should not assert that the pill updates — that requires the fix. The Q5 DisciplineCounter overlay is wired with empty state; clicking the pill in demo opens an overlay that says "No data".

4. **Auth token decoding.** `OnsiteWebSocketContext.readUserIdFromLocalStorage` reads `auth-token` JWT and parses base64url payload. If the JWT doesn't have `sub` or `id`, `userId` is null and the hello frame's userId field is null. Server should tolerate null userId; if it crashes, Batch 8 will surface it.

5. **Static scanner grep patterns from implementer report are correct.** All `grep -nE ...` patterns produce zero (or expected) output against the current tree.

6. **Hard-coded customer list**. CustomerSelect's options are loaded from `config.data.customers`. If the server config endpoint returns zero customers, the select is `disabled` (line 60) and the wizard can't proceed — fine for demo but worth noting for the demo script.

## Recommended fix-executor scope (Batch 7 fix)

A minimal fix-batch should:
- **C1 fix**: Decide between (a) passing counts as props from OnsiteChatStream to DisciplineCounter, or (b) moving the WS subscription and tally into DisciplineCounter. Either is fine — option (a) is the smaller diff. Also remove dead `void` props and unused local state setters in DisciplineCounter.
- **M1, M2 cleanup**: Remove the hardcoded `slice(0, 4)` once C1 lands; remove unused `resetKey` prop or wire it.

No other changes are required to clear Batch 7.
