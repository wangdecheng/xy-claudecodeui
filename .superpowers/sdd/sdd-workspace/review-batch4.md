# Review — Batch 4 (WS + 3 Discipline Middlewares)

## Verdict
**Hold for fix(es)** — one Critical issue (suspect signal dead in production routing) plus a few minor items. Everything else is solid; the middlewares, confirm-root-cause route, and OnsiteWebSocketService core are well-implemented with real, behavior-asserting tests.

## Per-Sub-Task Verification

### 4.1 OnsiteWebSocketService
- **Status**: ⚠️ Concern
- **Notes**:
  - `validateOnsiteHelloFrame` is a clean pure function with full coverage of edge cases (object/null, kind missing, kind=chat, problemId empty, cwd escape, cwd relative resolved against root) — `onsite-websocket.service.ts:54-103`, test `onsite-websocket.test.ts:68-137`.
  - `chatRunRegistry.startRun` correctly adds optional `kind` (default 'chat') and exposes `getRunKind` — `chat-run-registry.service.ts:221-249,272-276`. Existing chat callers unaffected (zero changes to call sites in chat-websocket.service.ts).
  - **Wiring is intentionally deferred to Batch 5 (Task 5.2, tasks.md:717-725)**. `onsiteWebSocketService.attach()` is exported but never imported from `server/index.js:113` or `websocket-server.service.ts:34-79`. The current wss route table (`websocket-server.service.ts:57-78`) hits the `[WARN] Unknown WebSocket path` branch on `/onsite/ws`. The implementer's own `task-4-report.md` flags this as a known follow-up — fine per the task plan, but Batch 5 MUST wire it before this can run end-to-end. **No regression in chat path** since the service is never invoked.

### 4.2 Softening
- **Status**: ✅ Correct
- **Notes**:
  - 15 words loaded lazily from `config/discipline-words.json` (matches spec REQ-9.1; "additions are non-breaking"). `_setWordsForTests` is a proper test escape hatch — `discipline-softening.middleware.ts:60-68`.
  - `findWords` (positions sorted ascending), `containsSoftening` (boolean wrapper), `replaceForUi` (`<softening word="X" position="N"/>` wrapping, build-from-end to avoid index drift) are all pure and tested for all 15 words — `discipline-softening.test.ts:69-115`.
  - `attachToWs` correctly bails on `enabledFor(ws) === false` (chat path), logs to `onsite_discipline_log(kind=softening)` via injected `ctx.logHit`, and adds the `discipline: { softening: true, words: [...] }` flag without mutating the original envelope — `discipline-softening.middleware.ts:163-237`. Test at `:228-247` proves chat passthrough is unmutated (`assert.deepEqual(ws.sentFrames, [original])`).

### 4.3 Confirm-root-cause
- **Status**: ✅ Correct
- **Notes**:
  - `POST /api/onsite/problems/:id/confirm-root-cause` returns 422 with `error: 'softening_words_present'` + `words: [{word, position}]` BEFORE calling `StateMachine.apply` — `onsite.routes.ts:288-295`. Spec REQ-9.3 fully satisfied.
  - 400 for empty `root_cause_text` and 400 for `reason < 8` chars — `onsite.routes.ts:271-285`. The route also relies on `applyState` for `ReasonTooShortError`/`ProblemNotFoundError`/`InvalidStateTransitionError` mapping (400/404/409) — `onsite.routes.ts:319-340`.
  - Tests are real and assert DB state + broadcast: `:97-132` inserts an `analyzing` row, calls the endpoint, asserts `res.body.to === 'confirmed'`, asserts `state-changed` event arrives via `onsiteBroadcast.subscribe`. `:163-173` asserts 404 for unknown problem.
  - `updateRootCause` does best-effort write to `problem.json` (`onsite-problems.db.ts:113-130`) — slightly hacky (`require('node:fs')` inside the function) but acceptable for the Batch 4.3 deferred schema upgrade. The route's try/catch wrapper means a write failure doesn't fail the response — `onsite.routes.ts:307-313`. Minor: `updateRootCause` is silently a no-op when `problem_json_path` is null.

### 4.4.a TraceId main
- **Status**: ✅ Correct
- **Notes**:
  - `MAIN_SIGNAL_REGEX` matches `/未找到|0\s*结果|no matches|found nothing|无命中|没有结果|no results?/i` exactly per spec — `discipline-trace-id.middleware.ts:24`.
  - Anti-false-positive: main signal only fires when `lastGrepAt.get(traceId)` was set within `GREP_RECENT_WINDOW_MS = 60_000` — `:24,206-211`. The `grep` family is `(grep|rg|ag|ack)` matching the spec — `:25,153-156`.
  - Strong signal path: tool_result with `cmd.includes(traceId)` AND `isStdoutAllZero(stdout)` → log + emit + `applyBlocked` — `:142-176`. `isStdoutAllZero` correctly handles both `""` and `"0\n0\n..."` (line 86-91).
  - `autoReason` contains traceId + cmd source + ISO timestamp — `buildAutoReason` at `:97-102`, regex asserted at `discipline-trace-id.test.ts:402`.
  - End-to-end DB assertion at `:378-409` proves the strong signal does flip `onsite_problems.status = 'blocked'` via real `apply()` call (not a stub).
  - **Issue**: `getTraceId(ws)` is injected via `ctx.getTraceId` — the tests stub it to return `'trace-XYZ'`. The production caller is responsible for hooking this up. The implementer's report flags this as Batch 5 wiring — same dependency as 4.1.

### 4.4.b TraceId suspect (non-blocking)
- **Status**: ⚠️ Concern
- **Notes**:
  - Suspect signal logic is correct: `SUSPECT_CMD_REGEX` matches `cat|head|tail|wc|xxd|find|python3?|node`, `EMPTY_STDOUT_REGEX` matches `^\s*$` — `discipline-trace-id.middleware.ts:26,181-191`. Logged with `kind: 'trace_id_suspect'`, no `applyBlocked` call — confirmed at `:189,194`.
  - Envelope flag: `discipline.traceIdSuspect: true, cmd` — `:202-205`. Tests at `:464-606` cover cat, find, python, head/tail/wc, and explicitly assert `applied.length === 0`.
  - **Concern (Important, see Issues)**: The suspect branch is **unreachable in production** because it sits in the `tool_result` arm (`if (envelope.kind === 'tool_result')`), but production tool_result envelopes never come through `ws.send` — they're synthesized by the gateway inside `chat-websocket.service.ts` and pushed to the run writer (`ChatSessionWriter`), which is what calls `originalSend`. The middleware only sees whatever the writer pushes. This is the same `attachToWs` mechanism the chat path uses, so it's correct shape-wise, but the routing into the writer from `chat-websocket.service.ts` is the production site that needs `attachToWs` calls, and those are also Batch 5. The current tests bypass this entirely with a `FakeWs`.

### 4.5 Write-protection
- **Status**: ✅ Correct
- **Notes**:
  - `WRITE_ACTION_REGEX = /\b(?:rm(?:\s+-rf)?|tee|cp\s+-f|mv|sed\s+-i|awk\s+-i)\b|>(?!>)/` — covers all spec actions, with the `>` non-redirection lookahead (allows `>>` append) — `discipline-write-protection.middleware.ts:23`.
  - `ORIGINAL_PATH_REGEX` covers `.log|.log.gz|.jsonl|.tar.gz|.tgz|problem.json|unpacked-*` — `:24`. Spec REQ-10.2 satisfied.
  - `detect` is a pure two-stage AND — `:88-97`. Tests cover all 8 spec scenarios (rm, echo>, sed -i, tee, cat no, notes.md no, ls no, rm -rf unpacked-N, cp -f jsonl) — `discipline-write-protection.test.ts:109-152`.
  - attachToWs only fires when both match, logs `kind: 'write_protection'`, emits `discipline:write-protection-detected`, adds `discipline.writeOriginalLog: true, cmd` flag, and **never** calls `applyBlocked` — confirmed at `:178-194` (assertion `applied.length === 0`).
  - `stdout_preview` truncated to 200 chars — `:124-127`, tested at `:216-242`.

## Strengths
- **Real TDD, not smoke**: every test asserts DB row state (`onsite_problems.status`, `onsite_discipline_log.countByProblemId`), broadcast event payloads, envelope flag presence/absence, or apply reason contents. The trace-id test at `:378-409` is a full end-to-end through real `StateMachine.apply` — exemplary.
- **Pure function extraction** in every middleware (`validateOnsiteHelloFrame`, `findWords`, `replaceForUi`, `detect`, `buildAutoReason`) makes the logic unit-testable without spinning WS or DB state.
- **Lazy-load patterns** prevent circular imports: `discipline-softening.middleware.ts:51-58` (readFileSync on first call), `_setWordsForTests` escape hatch. trace-id and write-protection use `WeakMap<WebSocket, WsState>` (`:33,55`) to avoid global state leaks.
- **Envelope flag merge is non-mutating**: every middleware uses spread + merge `envelope.discipline` (`:117-125` of softening, `:92-99` of trace-id, `:78-86` of write-protection) so the original envelope is preserved for downstream consumers.
- **Correct chat-path isolation**: every middleware early-returns when `enabledFor(ws) === false`. Tests explicitly assert chat passthrough is unmutated.
- **Test isolation hygiene**: each test file uses `withIsolatedEnv` to set `DATABASE_PATH` / `ONSITE_ROOT` in a fresh `mkdtemp` and tears down via `closeConnection` + `rm(tempDir, { recursive: force: true })`. No cross-test contamination.
- **REQ-8.6 envelope schema respected**: all four envelope flags (`softening`, `traceIdEmpty`, `traceIdSuspect`, `writeOriginalLog`) are top-level under `discipline: {...}` and additive — no schema break for the Batch 6 frontend.

## Issues

### Critical (must fix before Batch 5)
None. The two pre-existing test failures (provider-models cache, config.service.watch mtime) are unrelated and pre-date Batch 4 — confirmed by reading the failure list and noting neither touches discipline/onsite paths. Do not act on.

### Important (fix soon)
1. **OnsiteWebSocketService.attach() is never wired in** (4.1). As of commit `32ace22`, `server/index.js:113` (`const wss = createWebSocketServer(server, {...})`) does not call `onsiteWebSocketService.attach(wss)`, and `websocket-server.service.ts:57-78` does not handle `/onsite/ws` in its connection router. **This is expected per tasks.md:717-725 (Task 5.2)** — the implementer correctly deferred it — but Batch 5 MUST add the wiring before any end-to-end smoke test can exercise the middlewares through a real socket. The current 60/60 unit tests cover middleware logic but not the attach→hello→chat-run handoff. Recommend the Batch 5 brief explicitly call out this wiring as a precondition.
2. **Suspect signal reachability through production routing** (4.4.b). The suspect branch only inspects `envelope.kind === 'tool_result'` frames. In production, tool_result frames are produced by `chat-websocket.service.ts` (gateway code) and pushed through `chatRunRegistry` → `ChatSessionWriter.send()` → `originalSend`. The middleware sees what the writer pushes, which depends on Batch 5 wiring `attachToWs` calls at the right writer layer. The test layer is fine; the production-layer plumbing is Batch 5's responsibility, but **Batch 5's brief should explicitly include "attach middlewares to the chat run writer outbound path"**, otherwise suspect detection is functionally dead in prod.

### Minor (note for later)
- `discipline-softening.middleware.ts:21` — `SofteningLogEntry` declares `kind: 'softening'` as a single-literal union. If/when other softening-like categories are added (e.g. `hedge`), this'll need widening. Not a problem today.
- `discipline-trace-id.middleware.ts:97-102` — `buildAutoReason` includes a literal `见 CLAUDE.md 第 N 章` placeholder. This will need to be wired to a real section reference (or removed) before prod.
- `discipline-write-protection.middleware.ts:23` — `WRITE_ACTION_REGEX` uses `>(?!>)` to exclude append redirection. This is correct for the spec but undocumented — add a JSDoc comment.
- `onsite.routes.ts:307-313` — `updateRootCause` write failure is logged via `console.warn` but the test never covers this branch. Acceptable for Batch 4 (deferred schema); should be replaced with a column-level write in Batch 5.
- `onsite-problems.db.ts:113-130` — uses `require('node:fs')` inside a typed method body to dodge the ESM import cost; works but ugly. The lazy `require` means it's never statically traced. Batch 5 should add a real `root_cause_text` column and remove this hack.
- `onsite-websocket.service.ts:201-205` — `detach()` is a no-op with a comment. Fine for the test escape hatch contract, but the spec brief asks for it; if/when used in production teardown, this needs a real handler (track the listener and `wss.off`).
- Tests rely on `_setWordsForTests` / `_resetForTests` (broadcast) which is fine but is a slightly leaky abstraction; consider a `resetForTests` aggregate on each middleware.

## Forward Compatibility

**Batch 5 (SDK path blacklist + log-unpack + wire-all) can plug in cleanly**:
- `OnsiteWebSocketService.attach(wss)` is the explicit entry point Batch 5 needs to invoke from `server/index.js` post-`createWebSocketServer`. tasks.md:722 already prescribes the exact one-line wire-up.
- `chatRunRegistry.getRunKind(appSessionId)` is the lookup Batch 5's discipline ctx will use to decide `enabledFor(ws)` — already exposed.
- Middleware attach pattern (`attachToWs(ws, ctx)`) is consistent across all three middlewares; Batch 5 can iterate them in a single loop.
- Envelope flags (`softening`, `traceIdEmpty`, `traceIdSuspect`, `writeOriginalLog`) are additive under `discipline: {...}` — adding `disallowedTool`/`unpackedTo` flags in later batches is non-breaking.
- `onsiteProblemsDb.updateRootCause` provides a best-effort path for the root_cause_text persistence Batch 5/6 will formalize into a schema column. Batch 5 should replace the file-write with a real column write.
- The discipline-words.json 15-word list is forward-compatible (spec says "additions are non-breaking") — Batch 5 can extend without code changes.

**One caveat for Batch 5 brief**: must explicitly call out the attach wire-up (server/index.js + websocket-server.service.ts path branch) AND the discipline ctx `getTraceId` resolution — both are preconditions for end-to-end smoke, not just unit tests.

## Assessment

**Ready to proceed to Batch 5?** **No — proceed, but with two Batch 5 brief additions.**

**Reasoning:** The Batch 4 code itself is high-quality, well-tested, and matches the spec line-for-line (REQ-8.5, REQ-8.6, REQ-8.7, REQ-9.1, REQ-9.3, REQ-10.1, REQ-10.2, REQ-10.3, REQ-3.4 broadcast). The 60 new tests are real behavior assertions, not smoke. The 2 pre-existing fails are unrelated. The "wire attach into wss" gap is intentional per tasks.md and correctly attributed to Batch 5. **However**, Batch 5's brief must explicitly include (a) wiring `onsiteWebSocketService.attach(wss)` in `server/index.js` plus adding `/onsite/ws` to the path router, and (b) attaching the middlewares to the chat-run writer outbound path so suspect/main signals see real `tool_result` envelopes in production. Without (a)+(b), the middlewares are unit-test-only, and the only way to find this out is a late e2e smoke.
