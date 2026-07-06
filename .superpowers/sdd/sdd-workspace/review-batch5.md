# Review — Batch 5 (Wiring + Path Blacklist + Log-unpack + Upload)

**Range reviewed:** `ea1d94d..03fe253` (6 commits, 1781+/20-)
**Reviewer:** Senior Code Reviewer
**Date:** 2026-07-04
**Spec:** `changes/customer-onsite-analysis-ui/specs/discipline-write-protection.md` REQ-10.x + `discipline-trace-id.md` REQ-8.7

## Verdict
**Hold for fix(es)** — wiring is correct and the 3 critical Batch 4→5 handoffs are closed, but one new test introduces a real concurrency/state-leak flake that fails in the full-suite run.

## Wiring Verification (CRITICAL)

### A.1 server/index.js attach
- **Pass**
- `onsiteWebSocketService.attach(wss)` is called AFTER `createWebSocketServer` at `server/index.js:159-160`. Test in `onsite-wiring.test.ts:235-254` asserts `attach` is callable and registers a connection listener.

### A.2 /onsite/ws path branch
- **Pass**
- `server/modules/websocket/services/websocket-server.service.ts:67-73` short-circuits with `return` when `pathname === '/onsite/ws'`, preventing the `[WARN] Unknown WebSocket path` log. The connection is left alive for the hello-frame handler registered by `onsiteWebSocketService.attach` in `onsite-websocket.service.ts:136-198`. Tests verify both attach is callable and non-onsite paths are not closed.

### A.3 Middleware on writer outbound path
- **Pass**
- `server/modules/websocket/services/chat-run-registry.service.ts:148-243` (new helper `attachOnsiteDisciplineMiddlewares`) wraps `run.writer.ws.send` with three middlewares: `disciplineSofteningMiddleware.attachToWs`, `disciplineTraceIdMiddleware.attachToWs`, `disciplineWriteProtectionMiddleware.attachToWs`.
- `startRun` gates the attach on `kind === 'onsite'` at lines 392-394.
- `attachConnection` re-attaches after reconnect at lines 449-457 (resets `__onsiteDisciplineAttached` flag).
- Idempotency guarded by `__onsiteDisciplineAttached` flag on the ws.
- `enabledFor` closure consults `chatRunRegistry.getRunKind(run.appSessionId)`, so even if the ws object survives a run-kind change the middleware short-circuits correctly.
- `getTraceId` source resolution at lines 218 reads `<cwd>/.traceId` first, then `process.env.TRACE_ID`, then `null`. Implementation uses `require('node:fs')` (lazy) in `loadTraceIdFromCwd` lines 132-141.
- `applyBlocked` wired via `applyState(id, 'blocked', reason, null)` (systemActorId = null, see wrapper at lines 199-205).
- Chat path explicitly NOT attached (`startRun` defaults `kind` to 'chat'; verified by test `startRun({kind:chat}) does NOT attach middlewares`).
- Test coverage: 6 tests in `onsite-wiring.test.ts` covering all 3 wiring items, idempotence, attach-on-reconnect, and chat-isolation.

### Minor typing concern (not a bug)
- The `getTraceId` closure in `chat-run-registry.service.ts:218` is `() => loadTraceIdFromCwd(cwd) ?? process.env.TRACE_ID ?? null` — zero-arg closure, but the middleware type signature expects `(ws: WebSocket) => string | null`. JS allows extra args, so this works at runtime. Not flagged as critical; could be tightened to `(..._args: unknown[]) => ...` later.

## Per-Sub-Task Verification

### A Wiring
- All three Batch 4→5 handoff gaps closed (verified by 6 tests in `onsite-wiring.test.ts`).
- `getTraceId` resolution chain correct: file → env → null.
- `applyBlocked` correctly delegates to `state-machine.apply(id, 'blocked', reason, null)`.
- Chat path unchanged: `enabledFor` returns false for non-onsite runs even after middleware is attached.

### B Path Blacklist
- `ONSITE_PROTECTED_GLOBS` has **7 entries** (`*.log`, `*.log.gz`, `*.jsonl`, `unpacked-*`, `problem.json`, `*.tar.gz`, `*.tgz`) at `onsite-path-blacklist.service.ts:21-29`.
- `toDisallowPatterns` covers: `rm`, `rm -rf`, `tee`, `sed -i`, `awk -i`, `cp -f`, `mv` (7 Bash actions) × each glob + Write + Edit. The brief mentioned `>` redirect and `python open`; the implementation omits these intentionally for the **hard layer** with documented rationale at lines 33-36 ("SDK 自己处理 shell 重定向"). This is a deliberate design choice — the soft layer (`discipline-write-protection.middleware`) still catches `>` and `cat … >` via the `WRITE_ACTION_REGEX`. Acceptable.
- Dedupe via `Set<string>` (line 75).
- `injectOnsiteBlacklist` is a pure function that adds to `sdkOptions.disallowedTools`.
- `claude-sdk.js` not modified (the existing `canUseTool` `isDisallowed` branch handles deny — verified by `git show e9b22e9 --stat`).
- 12 tests in `onsite-path-blacklist.test.ts` cover all 7 globs × Bash/Write/Edit + dedupe + chat-path isolation.

### C Log-unpack
- `unpackMany(files, destDir, options?)` returns `UnpackResult[]` (union of ok/failure cases).
- 200MB single-file limit throws `PayloadTooLargeError` (lines 100-108) with **batch-wide rollback** of any already-created `unpacked-N/` dirs.
- 20-file total limit throws `TooManyFilesError` (lines 97-99).
- Corrupted zip: `unpackOne` deletes `unpacked-N/` (lines 147-155), returns `{ ok: false, originalName, error: 'corrupted_zip' }` via `classifyError` (lines 158-163).
- Empty input returns empty array (line 94).
- Uses system `unzip` command via `child_process.spawn` — no new dependency.
- 7 tests in `log-unpack.test.ts` cover all branches.

### D Upload Routes
- `POST /api/onsite/problems/:id/files` with `multer.array('files', 20)` middleware (`onsite.routes.ts:411-428`).
- 200MB file-size + 20-file count limits at multer (lines 65-69) AND re-enforced in `unpackMany`.
- 207 multi-status response with per-file `results[]` (lines 495-507).
- Successful uploads insert into `onsite_files` via `onsiteFilesDb.insert({kind: 'archive', unpacked_dir: ...})` (lines 480-491).
- 413 returned for both `PayloadTooLargeError` and `TooManyFilesError` (lines 466-473).
- 400 `NO_FILES` when no files in form (line 434-437).
- 400 `BAD_FIELD_NAME` for multer LIMIT_UNEXPECTED_FILE (line 421).
- 404 `PROBLEM_NOT_FOUND` when problem not found (line 449-451).
- Existing `GET /api/onsite/problems/:id/files` preserved at lines 514-528.
- `multer ^2.0.1` declared in root `package.json:179`.
- 6 tests in `onsite-upload-routes.test.ts` cover all status codes.

### E Root Cause Column
- `root_cause_text TEXT` column added to `onsite_problems` schema (`schema.ts:141-145`).
- Migration step `006_add_root_cause_text` added to `ONSITE_MIGRATION_STEPS` (`migrations.ts:738-743`) with fixed SQL `ALTER TABLE onsite_problems ADD COLUMN root_cause_text TEXT`.
- `migrateAll` runs `addColumnToTableIfNotExists(db, 'onsite_problems', ..., 'root_cause_text', 'TEXT')` for **idempotent** upgrade of pre-existing databases (`migrations.ts:505-510`).
- `updateRootCause` simplified at `onsite-problems.db.ts:120-128` — pure `UPDATE root_cause_text = ?` SQL, no `require('node:fs')`.
- `SELECT_COLUMNS` includes the new column (line 43).
- `OnsiteProblemRecord` type updated to include `root_cause_text: string | null` (line 26).
- Route handler at `onsite.routes.ts:368` calls the new `onsiteProblemsDb.updateRootCause(id, rootCauseText)`.
- 5 new tests in `onsite-root-cause-column.test.ts` + 1 adjusted in `onsite-migration.test.ts`.

## Strengths
- Wiring verification is **real**, not smoke: tests assert actual envelope-flag injection (e.g. `discipline.softening === true` after `run.writer.send({content: '可能是这个问题'})`).
- Test coverage goes beyond unit tests — middleware integration via `chatRunRegistry.startRun` proves the wire-up actually delivers tool_result envelopes through the discipline pipeline.
- Idempotent migration: `addColumnToTableIfNotExists` makes the schema upgrade safe for databases created before Batch 5.
- Path blacklist has documented design rationale for omitting `>` redirect (SDK handles shell redirection natively).
- Log-unpack uses system `unzip` instead of adding `unzipper` dependency — keeps the bundle small.
- Existing endpoints (`GET /files`, `PATCH /problems/:id`, etc.) preserved unchanged.

## Issues

### Critical (must fix before Batch 5.5)
1. **Upload-routes corrupt test fails in full-suite run with concurrency/state-leak issue.** The test `POST with corrupted zip → 207,2 rows in DB, unpacked-3 missing` passes in isolation and even when run with just `config.service.watch.test.ts` or `onsite-wiring.test.ts`. It fails when `chokidar` config tests and `upload-routes` tests run together in the same `tsx --test` invocation. Symptom: `unpacked-1` exists but `unpacked-2` does not, even though `body.results.filter(r => r.ok).length === 2`. Likely root cause: a shared mutable global (probably `process.env.ONSITE_ROOT` race or a singleton from `loadConfig`) is being touched between tests. Commit `03fe253` (unique problemId) addressed the symptom but did not close the leak. **Fix candidate:** tighten `withIsolatedEnv` to always reset `ONSITE_ROOT` to a fresh `tempDir` (drop the `if (!previousRoot)` gate at `onsite-upload-routes.test.ts:66-68`).

### Important (fix soon)
2. **`getTraceId` closure typing mismatch** (cosmetic but distracting): the wiring closure `() => loadTraceIdFromCwd(cwd) ?? process.env.TRACE_ID ?? null` ignores the `ws` argument. Works at runtime but fails strict TS checks in some configs. Either add `(_ws: WebSocket) =>` or relax the middleware's signature.
3. **No test for the `attachConnection` re-attach idempotence flag reset** beyond a single end-to-end test. The reset logic at `chat-run-registry.service.ts:454-456` sets `__onsiteDisciplineAttached = false` on the new connection — correct, but if a future refactor forgets to reset, double-wrap could occur. A targeted unit test would harden this.

### Minor (note for later)
- Path-blacklist brief called out `>` redirect and `python open` patterns, but the implementation intentionally omits these for the hard layer (documented rationale: SDK handles shell redirection natively; Python open is out of scope for this layer). Soft-layer (`discipline-write-protection.middleware`) still catches `>` via the regex. Not a regression — but the spec/brief should be updated to reflect the deliberate split.
- The multer middleware returns 413 with `PAYLOAD_TOO_LARGE`/`TOO_MANY_FILES` *before* the route handler runs (good), but the test for "single 250MB file → 413" was not included in `onsite-upload-routes.test.ts` (6 tests listed; the brief required 4+). The multer-level 413 path is tested indirectly via the integration but lacks a dedicated assertion.

## Cross-cutting
- **Chat path unchanged:** Verified by `scripts/regression-chat.sh` returning `305/1` (the 1 fail is the pre-existing `provider-models.cache` flake). Baseline was `157/1` from earlier era — pass count grew as new tests were added, but fail count stayed at 1.
- **Server boot succeeds:** No startup crashes observed during test runs.
- **New dependencies:** `multer ^2.0.1` declared in root `package.json`. `unzipper` not used (system `unzip` only).
- **Pre-existing 2 fails:** `provider-models.cache` + `config chokidar mtime` flakes are unchanged. The chokidar flake sometimes does NOT trigger (timing-dependent) — sometimes 2 fails, sometimes 3. **The new failure is `onsite-upload-routes.test.ts:10:2030` — `POST with corrupted zip`** — see Issue #1.

## Forward Compatibility

**Batch 5.5 (chat regression gate):**
- Chat regression: 305 pass / 1 fail — same 1 pre-existing flake as baseline. Chat path is safe to gate on.
- Migration length assertion updated from 4 → 5 in `onsite-migration.test.ts:1:994` — confirms Batch 5's migration step registers correctly.

**Batch 6 (frontend):**
- Frontend can proceed against the new endpoints (`POST /api/onsite/problems/:id/files` with 207 multi-status response).
- `root_cause_text` column is now persistent in DB; UI can render it after `confirm-root-cause` success.
- `discipline.writeOriginalLog` / `discipline.softening` / `discipline.traceIdEmpty` envelope flags are wired into production tool_result envelopes — frontend can render them.

**Action items before Batch 5.5 can fully clear:**
- Fix Issue #1 (upload-routes test concurrency state leak).
- Verify chat regression matches baseline after fix.

## Assessment

**Ready to proceed to Batch 5.5?** **No** — Issue #1 must be fixed first.

**Reasoning:** Wiring is solid and the 3 critical Batch 4→5 handoffs are correctly closed, but the upload-routes test reliably fails in full-suite runs due to a concurrency/state-leak bug that the unique problemId commit did not address. Until this is resolved, the test suite cannot be trusted as a regression gate for chat path verification (the new fail could mask real chat regressions).