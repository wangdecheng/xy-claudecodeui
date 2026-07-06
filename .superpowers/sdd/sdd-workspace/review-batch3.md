# Review — Batch 3 (StateMachine + REST + Broadcast)

## Verdict
Ready to proceed to Batch 4

## Per-Task Verification

### 3.1 StateMachine
- Status: ✅ Correct
- Notes:
  - All 5 statuses defined (`pending_info`/`analyzing`/`blocked`/`confirmed`/`abandoned`) and `ALLOWED.abandoned = []` (terminal) at `state-machine.service.ts:24-30`. `abandoned` is reachable from every non-abandoned state via outgoing lists.
  - `canTransition` is pure — only reads the closure-captured `ALLOWED` table, no DB/IO/time (`state-machine.service.ts:84-95`).
  - `apply` performs reason trim → `findById` → `canTransition` → `db.transaction(() => { updateStatusOnly + audit append })()` then attempts problem.json sync outside the transaction (`state-machine.service.ts:97-150`). better-sqlite3 `db.transaction(fn)()` is synchronous and atomic at the SQLite level — both writes all-or-nothing.
  - Three custom errors with `.code` (`INVALID_STATE_TRANSITION` / `REASON_TOO_SHORT` / `PROBLEM_NOT_FOUND`), fully consistent with existing `MigrationCorruptionError`/`CwdEscapeError` pattern (`state-machine.service.ts:32-83`).
  - Tests are **real**, not smoke: 11 legal + 11 illegal + 4 apply error paths + happy-path + atomicity. The atomicity test seeds a problem, attempts an illegal transition, then asserts both `status` and `audit` row count unchanged (`state-machine.test.ts:215-260`). Trade-off acknowledged: test verifies "illegal transition doesn't write anything", not "mid-transaction exception rolls back both" — could be tightened by injecting a repo failure. Minor.

### 3.2 REST Routes
- Status: ✅ Correct
- Notes:
  - All 5 endpoints implemented: GET list (`onsite.routes.ts:67-75`), POST (`onsite.routes.ts:88-156`), GET `:id` (`onsite.routes.ts:160-173`), PATCH `:id` (`onsite.routes.ts:186-239`), GET `:id/files` (`onsite.routes.ts:243-256`).
  - POST validation order: 4-field required (400) → config not loaded (503) → customer not in config (422) → `CwdEscapeError` (409) → 201 (`onsite.routes.ts:91-156`).
  - PATCH validation: reason ≥ 8 chars (400, includes trim) → `ReasonTooShortError` → `ProblemNotFoundError` (404) → `InvalidStateTransitionError` (409 with `from`/`to`/`allowed`) → 200 + broadcast (`onsite.routes.ts:186-238`).
  - Sort order is `STATUS_ORDER` map with `compareStatus` comparator (`onsite.routes.ts:55-63`). Matches spec: blocked→analyzing→pending_info→confirmed→abandoned.
  - Routes mounted under `app.use('/api/onsite', authenticateToken, onsiteRoutes)` at `server/index.js:232` — auth verified at the mount point, not per-handler. The 401 test exercises the real `authenticateToken` middleware (`onsite.routes.test.ts:281-302`).
  - Tests are real: each endpoint has happy + error paths, status codes asserted strictly, broadcast verified by subscribing and counting received events (`onsite.routes.test.ts:241-260`), DB state asserted via `onsiteStateAuditDb.listByProblemId` (`onsite.routes.test.ts:225-235`).

### 3.3 Broadcast
- Status: ✅ Correct
- Notes:
  - `subscribe(sub)` returns unsubscribe; `unsubscribe(sub)` works; per-subscriber try/catch around `sub.send` (`onsite-broadcast.ts:36-49`). `subscriberCount()` exposed (`onsite-broadcast.ts:55-57`). `_resetForTests()` documented as test-only (`onsite-broadcast.ts:63-65`).
  - `BroadcastEvent` is a discriminated union with template literal type `problem:${string}:state-changed` so `id` is part of the type (good).
  - **Watcher integration at `server/index.js:1792-1794`**: `startOnsiteWatcher()` then `onWatcherChange(() => onsiteBroadcast.broadcast({ type: 'problems:changed' }))`. Both imports added at lines 73-74. Shutdown path uses `stopOnsiteWatcher()` (line 1804). Verified.

## Strengths

- **Spec discipline**: REQ-3.1/3.2/3.3/3.4 all addressed; error response shapes match the spec's "scenario" examples (e.g. `allowed` array on 409, `reason` in 400).
- **Typed errors** carry structured fields (`from`/`to`/`allowed`/`minLength`/`id`) — route layer translates to HTTP without re-deriving context.
- **Atomicity correctness** for the DB portion: `db.transaction(() => {...})()` in better-sqlite3 is synchronous + atomic, so the audit row and status update are committed together or roll back together. The intentional split of problem.json fs-IO outside the transaction is a defensible trade-off (D-3: disk is source of truth, fs failures won't corrupt DB).
- **Test quality**: tests use supertest + node:test, isolated DB+ROOT env (`withIsolatedEnv` helper), and assert against actual DB / disk state — not smoke tests. 52 new tests, all pass.
- **Forward compatibility for Batch 4**: `onsiteBroadcast` accepts any object with `send(event)` — WebSocket handlers can drop in directly. `Subscriber` interface is unopinionated.

## Issues

### Critical (must fix before Batch 4)
None.

### Important (fix soon)
- **Atomicity test does not exercise mid-transaction failure** (`tests/state-machine.test.ts:215-260`). The test actually verifies "illegal transition rejected before transaction begins", which is a correctness check but not a true rollback test. A stronger test would inject a fault into `onsiteStateAuditDb.append` (e.g. monkey-patch the repo) and assert that `onsiteProblemsDb.findById(id).status` remains unchanged. Not a bug — just a coverage gap.

- **`apply` returns `at` from a fresh `listByProblemId` query** (`state-machine.service.ts:142-145`). This is a second DB read after the transaction. If many concurrent PATCHes happen, the `at` value is a slight over-estimate. Acceptable for now; if Batch 4 needs `at` as a causal timestamp, the audit repo's `append` should return the inserted `at` directly.

- **`getConnection()` is called once at the top of `apply`**, but `db.transaction(() => {...})()` is invoked synchronously. If in the future `db.transaction` ends up being called on a connection that has been closed (e.g. between the `findById` and `txn()`), error handling is unclear. Currently safe because `findById` would have thrown first. Worth a comment.

- **PATCH route uses `.then/.catch` instead of `async/await`** (`onsite.routes.ts:184-239`). The brief's "关键决策" notes this is to avoid Express 5 unhandled-rejection surprises — but it's inconsistent with the surrounding handlers which use `async`/`await`. The shape is fine; the inconsistency is the smell. Consider wrapping in `Promise.resolve().then(...)` or extracting to a helper.

### Minor (note for later)
- `PATCH` returns `{from, to, at}` but the spec REQ-3.3 Scenario only requires that audit row is persisted — not that response body has `at`. The current response is more verbose than the spec, which is fine (extra info).
- `state-machine.service.ts:142-145`: if no audit row exists (theoretically possible if someone manually purged), `at` falls back to `new Date().toISOString()`. Defensive, but `audits[audits.length - 1]` after a successful `append` should never be empty.
- `_resetForTests()` is appropriately underscore-prefixed — good convention. Consider exporting it through a separate testing re-export to make accidental prod usage more obvious.
- REST routes register `/config` in this commit, but the file's JSDoc says "Batch 1" for it — the docstring was pre-existing. Not a regression.
- `compareStatus` uses `?? 99` for unknown statuses — defensive but masks data corruption. Could assert/log for diagnosability.

## Forward Compatibility

**Batch 4 (WebSocket + middlewares) can plug in cleanly**:
- `onsiteBroadcast.subscribe(sub)` accepts any `{send}` object — `ws.send` adapter is one line.
- `BroadcastEvent` union is extensible (`problem:<id>:files-changed` etc. just add to the union).
- `StateMachine.apply`'s `actorId` already accepts `null` — system actors (Claude webhook, watcher) can pass through.
- Auth at the mount point (`app.use('/api/onsite', authenticateToken, onsiteRoutes)`) means Batch 4 can use the same `authenticateWebSocket` middleware pattern without per-handler changes.
- `reason` and `at` are part of the broadcast payload — clients can already show who/why/when in the badge without a separate GET.

## Assessment

**Ready to proceed to Batch 4?** Yes

**Reasoning**: All 3 sub-tasks implement correctly against the spec; tests are real (not smoke) and 52/52 pass; REST error mapping is faithful to spec scenarios; broadcast is properly wired to both the watcher and the PATCH route; atomicity holds for the DB portion and the intentional problem.json-out-of-transaction split is documented and defended. The only Important item (atomicity test gap) is coverage, not correctness — Batch 4 will exercise this code path under concurrent load, making any real bug surface quickly.
