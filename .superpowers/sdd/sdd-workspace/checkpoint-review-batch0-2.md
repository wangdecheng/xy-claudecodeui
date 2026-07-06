# Checkpoint Review — customer-onsite-analysis-ui (Batches 0~2)

> Reviewer: Senior Code Reviewer (checkpoint pass)
> Range: `6a88025..72c8725` (17 commits, 42 files, +5270 / -21 lines)
> Batches in scope: 0 (chat regression gate), 1 (config & hot-reload), 2 (DB + problem mgmt) + 2 fix commits.
> 6 batches remain (3, 4, 5, 5.5, 6, 7, 8).

---

## Verdict

**Ready to proceed to Batch 3:** **Yes with caveats** — one Critical issue must be addressed before Batch 3 starts (the migration SHA for step 1 is computed over a placeholder string, defeating the integrity check for the most-modified SQL). Several Important issues are tracked as follow-ups and can ship alongside Batch 3 if explicitly flagged.

---

## Strengths

- **C-4 actually fires when needed.** `server/index.js:1738-1742` wires `handleMigrationCorruption` into the startup try/catch; the helper itself is robust — `isMigrationCorruptionError` (`init-helpers.ts:44-53`) discriminates via both `instanceof` and a guarded duck-typed `name` check, and re-throws non-corruption errors so existing error flows stay intact. The 6 tests in `init-helpers.test.ts` exercise the discriminator's full surface, including string / null / undefined / duck-typed / plain object inputs.
- **Disk-as-source-of-truth is honored.** `problem.service.ts:121-176` writes `problem.json` first, then attempts the DB insert; if the DB write fails, it logs and resolves (the next `list` reconciles). The CwdEscapeError test (`problem.service.test.ts:137-149`) actually drives the escape path with `cwd: '/etc'`.
- **Hot-reload correctly preserves last-known-good.** `config.service.ts:208-220` rejects invalid config with `emitInvalid` while leaving `cachedPayload` untouched. `config.service.watch.test.ts:139-164` is a real test — it writes a config that violates the `customers[0]` rule and asserts the singleton is unchanged + the `onInvalid` callback fires.
- **The dedup bug caught in batch review was actually a real bug.** The `nextAvailableDirName` test (`problem.service.test.ts:83-135`) now uses the same `cwd` twice to drive the suffix loop, which is the correct test shape.
- **Sessions schema is chat-compatible.** `schema.ts:99-130` adds `kind TEXT NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat','onsite'))` with `cwd / third_bridge_branch / iteration / database` as nullable columns. `onsite-migration.test.ts:75-85` actually exercises the CHECK constraint by attempting a `'bogus'` insert and asserting the throw. The change to `sessionsDb.createSession` (`sessions.db.ts:121-141`) preserves existing insert paths without forcing onsite columns — non-breaking for chat.
- **Repository pattern is consistent across all four onsite repos.** `onsite-problems / onsite-files / onsite-state-audit / onsite-discipline-log` all use the `getConnection().prepare(...).run(...)` shape with typed insert/find/list methods. `INSERT_SQL` / `SELECT_COLUMNS` constants are exported as module-local. No coupling to Express, no business logic in the repo layer.
- **Regression scripts are testable in isolation.** `scripts/tests/regression-chat.test.ts` and `scripts/tests/diff-chat-impact.test.ts` exercise `--dry-run`, `--help`, unknown flags, baseline preservation, zero-diff, and "critical file changed → exit 1" with proper branch creation/cleanup in `finally`. The CI workflow (`.github/workflows/regression.yml`) is sane — uses `pull_request.base.sha` / `head.sha` directly, doesn't re-run on every commit, and uploads the baseline as a 30-day artifact.
- **Watcher's debounce is well tested.** `onsite-watcher.test.ts:140-166` issues 5 rapid creates and asserts `1 ≤ calls ≤ 3`, which is a real assertion against coalescing, not a "did it fire" smoke test.

---

## Issues

### Critical (Must Fix — would block Batch 3 or cause data loss)

#### C-1. Step 1 migration SHA is computed over an English placeholder, not real SQL

- **File**: `server/modules/database/migrations.ts:683-688`
- **What**: The first entry in `ONSITE_MIGRATION_STEPS` declares:
  ```ts
  sql: 'ADD COLUMN kind / cwd / third_bridge_branch / iteration / database',
  ```
  The lazy SHA loop at `migrations.ts:713-717` then runs `sha256('ADD COLUMN kind / cwd / third_bridge_branch / iteration / database')` — a stable hash of an English literal.
- **Why it matters**: The C-4 integrity check is supposed to detect when someone edits a SQL constant without bumping the migration name. For step 1, the "SQL constant" is the literal English description, which is never going to drift in lockstep with the real `addSessionsKindAndOnsiteColumns(db)` function (`migrations.ts:540-566`). The four subsequent steps (002–005) hash the real `ONSITE_*_TABLE_SCHEMA_SQL` constants and will catch drift there. But the entire `sessions` schema extension — the most likely thing future contributors will mutate (add columns, change defaults, etc.) — is **completely unguarded**.
- **Concrete blast radius**: A developer adds a new `sessions` column in step 1 without bumping the name → `verifyMigrations` returns `ok: true` → the integrity check passes silently → the migration rolls forward in a way the integrity layer never sees. That's the exact failure mode C-4 was designed to prevent.
- **How to fix**: Either
  1. Compose the SHA from the actual function call sites by exporting the SQL strings from `addSessionsKindAndOnsiteColumns` as constants and concatenating them, then hashing the concatenation; OR
  2. Drop step 1 from `ONSITE_MIGRATION_STEPS` entirely (the table itself is created in `INIT_SCHEMA_SQL`) and only track steps that do their own `db.exec(...)` — accepting the slight semantic shift that "adding columns to an existing sessions table" is no longer SHA-tracked. Add a JSDoc note explaining the trade-off.
- **Recommended**: Option 2 is cleaner. The integrity check is most useful for DDL-with-fixed-shape (CREATE TABLE); ALTER TABLE migrations are inherently additive and harder to hash consistently.

#### C-2. `config.service.test.ts:35-45` parses the live `config/customer-analysis.json` — assertion is brittle to config edits

- **File**: `server/modules/onsite-analysis/tests/config.service.test.ts:39-40`
- **What**: The test asserts `cfg.data.customers.length === 13` and `iterations.length === 2` against the live config file (which currently has 13 + 2). The contract test for the config service should not depend on the count of business entries — that's a property of the JSON file, not the service.
- **Why it matters**: When a customer is added to `config/customer-analysis.json` (the documented "add a row to extend the dropdown" workflow), this test breaks — and the dev has to remember to bump `13` → `14`. Worse: a typo or schema drift on the *service* (e.g. dropping `customers` from the response) won't be caught because the test will fail on the count first, masking the real regression.
- **How to fix**: Either assert on shape (`>= 1`, first item equals "不涉及三方对接", `branch === null`) using a fixture-controlled `loadConfig(fixturePath)` call, or split into two tests: one for the live-config smoke check (using a range assertion) and one for the fixture-driven shape check (using `good-minimal.json`).

---

### Important (Should Fix — fix in this checkpoint window)

#### I-1. `regression-chat.sh` parses multiple `ℹ tests N` lines as a SUM rather than the LAST value

- **File**: `scripts/regression-chat.sh:166-168`
- **What**: The script uses `awk '/pass/ { sum += $NF } END { print sum+0 }'` which sums across all `ℹ pass N` lines in the output. Node's TAP reporter prints a per-file `ℹ pass N` and a global `ℹ pass M`. The current baseline (`chat-regression-baseline.txt:1`) shows `78 1 8862` — when the script ran, the sum happened to match the global total because there was effectively one file, but with multiple test files this will double-count.
- **Why it matters**: The regression gate's whole purpose is to detect behavioral drift. If the pass count is wrong on every run, the diff against the baseline will be noisy and either false-positive (spurious break) or false-negative (real drift masked by inflation).
- **How to fix**: Use the LAST occurrence of each metric (take `$NF` from the final matching line) instead of summing:
  ```bash
  PASS_COUNT="$(grep -E '^ℹ +pass' "$TMP_OUT" | tail -n1 | awk '{ gsub(/[^0-9]/, "", $NF); print $NF+0 }')"
  ```
  The `progress.md` follow-up #2 already flagged this — this is a real correctness issue, not just fragility. Promote from Minor to Important.

#### I-2. `diff-chat-impact.sh:129` — `CRITICAL_PATTERNS` "sessions" lacks trailing slash, relies on case-statement expansion

- **File**: `scripts/diff-chat-impact.sh:125-152`
- **What**: The pattern `"server/modules/database/repositories/sessions"` is matched by `case "$f" in "${p}"*.ts|${p}*.js)` which works for any file starting with `server/modules/database/repositories/sessions` followed by `.ts` or `.js`. But the `progress.md` follow-up flagging this as Minor is misleading — it actually works correctly for the current paths. The concern is the OTHER direction: a file like `server/modules/database/repositories/sessions-archive.db.ts` (hypothetical) would also match, which is probably desirable. **Verifying this is not actually broken**, demoting from the prior Minor tracking.
- **How to fix**: No code change; remove from follow-up log since the pattern is correct. (Documented for reviewer accuracy only.)

#### I-3. `config.service.ts:73` — `resolveConfigPath` doesn't normalize, but `watchConfig` does — inconsistent

- **File**: `server/modules/onsite-analysis/config.service.ts:72-74, 235`
- **What**: `resolveConfigPath` returns `path.isAbsolute(input) ? input : path.resolve(process.cwd(), input)` without calling `path.normalize`. The bootstrap / watch flow re-resolves the same input, but subscribers may receive a payload whose `mtime` was computed from a non-normalized path. Combined with `process.chdir` in the test at `config.service.test.ts:96-110`, this can produce subtle "different absolute string, same file" mismatches in `chat-run-registry.service.ts` downstream.
- **Why it matters**: Subtle. The path doesn't change mtime semantics, but downstream comparison logic (Batch 4 middleware path-blacklist) will need to normalize before string-matching. Get the normalization discipline right here so Batch 5 doesn't have to re-discover it.
- **How to fix**: Add `path.normalize(...)` after the resolve. One-line change.

#### I-4. `config.service.ts:289-297` — `bootstrapConfig` can race with `watchConfig`

- **File**: `server/modules/onsite-analysis/config.service.ts:290-297`
- **What**: `bootstrapConfig` does `await loadConfig(resolved); if (watchedPath !== resolved) watchConfig(resolved)`. Between the load and the watch, a file change can occur that's missed by the watcher (chokidar's `ignoreInitial: true` skips the start state). More importantly, the test `config.service.watch.test.ts:139-164` (invalid-config-restore) shows that the first `loadConfig` happens before `watchConfig`, so a change between them is invisible.
- **Why it matters**: Low for typical single-server use, but the `server/index.js:1782` bootstrap happens in `server.listen` callback. A config change that arrives between `bootstrapConfig` returning and chokidar attaching its first listener will not be observed until the next write.
- **How to fix**: Either start the watcher BEFORE the initial load (with the watcher's first event firing the actual load), or set `ignoreInitial: false` and ignore the very first `add` event after a `ready` signal. Acceptable to defer — the window is small.

#### I-5. `onsite.routes.ts:26-28` returns 503 when config isn't loaded, but the test asserts only `5xx`

- **File**: `server/modules/onsite-analysis/onsite.routes.ts:26-29`, `server/modules/onsite-analysis/tests/config.route.test.ts:81-90`
- **What**: The route returns 503 specifically when `getConfig()` throws; the test asserts `>= 500 && < 600`. The implementation comment at `onsite.routes.ts:7` says "Authentication is applied at the server mount point" — but the wire path through `server/index.js:232` is `app.use('/api/onsite', authenticateToken, onsiteRoutes)`, which means the routes ARE protected. The 503 fallback is fine.
- **Why it matters**: Low; the test's relaxed assertion masks the actual 503 contract. If someone later changes the fallback to 500, the test still passes — which is intentional flexibility, but also means the response shape isn't tested strictly.
- **How to fix**: Tighten the test to assert `503` exactly. Or remove the route's fallback complexity and let `getConfig` throw at startup.

#### I-6. `onsite-problems.db.ts:87-94` — `updateStatus` ignores `reason` and `actorId` parameters

- **File**: `server/modules/database/repositories/onsite-problems.db.ts:87-94`
- **What**: The repository signature accepts `(id, status, _reason, _actorId)` but the SQL only updates `status` and `updated_at`. The audit row that would carry `reason` / `actor_id` is supposed to be written by `onsiteStateAuditDb.append(...)` (the caller is responsible — see `onsite-state-audit.db.ts:27-42`), but the repository gives no hint of that contract.
- **Why it matters**: For Batch 3 (StateMachine), the route handler will need to write BOTH the status update AND the audit row. If the developer reaches for `updateStatus` thinking it does both, they'll silently lose audit data. The TS signature with `_reason` / `_actorId` makes the dead-parameter smell more dangerous — it's intentional now, but the next reader might assume it's still TODO.
- **How to fix**: Either
  1. Rename the method to `updateStatusOnly(...)` to make the contract explicit, OR
  2. Accept an `auditAppend` callback that runs in the same `db.transaction()` as the update so the two writes are atomic.

#### I-7. `onsiteWatcher.ts:80-86` — ignored patterns include `unpacked-*/**` and `analysis/**` but these are FUTURE directories

- **File**: `server/modules/onsite-analysis/onsiteWatcher.ts:80-86`
- **What**: The watcher ignores `**/unpacked-*/**` and `**/analysis/**` because the proposal says log unpacking creates `unpacked-N/` and Batch 5 will create `analysis/`. Currently neither exists on disk, so these patterns are no-ops today — which is fine, but it's a forward-declared invariant without a test.
- **Why it matters**: When Batch 5 lands and starts creating `unpacked-1/` dirs, the watcher will silently skip file events from inside them. If the rule was wrong (e.g. analysis files should trigger events), the bug will be hard to find because the watcher doesn't surface "I skipped this path" telemetry.
- **How to fix**: Add a TODO test that creates `unpacked-1/problem.json` and asserts no event fires. Optional; can ship without.

#### I-8. `onsiteWatcher.ts:120-131` — `stopOnsiteWatcher` clears `listeners` globally, breaking parallel tests

- **File**: `server/modules/onsite-analysis/onsiteWatcher.ts:120-131`
- **What**: The `listeners.clear()` is a sledgehammer — if test A is still subscribed and test B's teardown runs, B's cleanup wipes A's listeners. Tests are currently serial in the suite, so this doesn't bite, but it's an accident waiting to happen with `--test-concurrency` > 1 (Node 22 supports this).
- **Why it matters**: Flaky tests in CI under load. `progress.md` follow-up #6 already flagged this — leave as-is for now, but call it out before anyone enables parallel test execution.

#### I-9. `schema.ts:99-130` — `kind CHECK` only applies on fresh installs; upgrade path is unguarded

- **File**: `server/modules/database/schema.ts:119` and `migrations.ts:540-566`
- **What**: The CHECK constraint is in the CREATE TABLE statement, but `addSessionsKindAndOnsiteColumns` adds `kind` via plain `ALTER TABLE ADD COLUMN` (SQLite limitation noted at `migrations.ts:533-539`). Upgraded DBs end up with a `kind` column but no CHECK enforcement — a stray `'admin'` write would silently succeed.
- **Why it matters**: For Batch 5.5 chat e2e (which depends on `kind` filtering), an upgraded chat server would let `kind='foo'` slip through. The runtime reads would just return 'foo' as a kind value with no error.
- **How to fix**: Either add an app-layer `assertKind(value)` guard in `sessionsDb.createSession` and `updateSession`, OR rebuild the table (heavy). Recommended: app-layer guard. Already in `progress.md` follow-up #1 for Batch 2.

---

### Minor (Nice to Have — note for later cleanup)

- `config.service.ts:160-170` — `_setConfigForTests` and `_stopWatchingForTests` are exported from production code. Acceptable but a `__test__` re-export from a `*.test-helpers.ts` would be cleaner. (Already tracked.)
- `init-helpers.ts:96` — when re-throwing a non-corruption error, the `throw err` will lose the original stack if any caller uses `Error.captureStackTrace` upstream. Not a real concern in this codebase.
- `problem.service.ts:206` — the `|| json.third_bridge_branch === null` check accepts a `null` value but the subsequent `?? null` re-coerces; the whole block could collapse to `typeof json.third_bridge_branch === 'string' ? json.third_bridge_branch : null`.
- `config.service.ts:85` — `schemaId: 'auto'` is ajv@6 syntax; if the transitive ajv upgrades, this will break silently. Already in follow-up.
- `regression-chat.sh:148` — `set +e` + capturing `${PIPESTATUS[0]}` is correct, but the script doesn't honor a `set -o pipefail` switch in callers. Acceptable.
- `diff-chat-impact.sh:101-108` — the WORKTREE branch uses `git diff --name-only HEAD` (without `--`), which means untracked files in `git status` aren't included; the `git ls-files --others --exclude-standard` patch on line 113-115 fills the gap, but only when WORKTREE is set. The `BASE_SHA == HEAD_SHA` branch (line 104-106) does NOT include untracked files. Minor inconsistency.
- `onsite-displiplog` (typo not present) — but `countByProblemId` (`onsite-discipline-log.db.ts:53-59`) returns a count without `kinds` breakdown. Batch 5 will need a breakdown query. Add `countByKindAndProblemId(...)` or just `listByProblemId(...)` for forward compat.
- `server/modules/database/tests/onsite-migration.test.ts:81` — uses `assert.throws(...)` without an assertion message; cheap to add.
- `server/modules/database/repositories/onsite-state-audit.db.ts:42` — returns `Number(info.lastInsertRowid)`; `info.lastInsertRowid` is already a `number` in better-sqlite3, so the cast is redundant but harmless.

---

## Forward-Looking Risks

These compound across remaining batches. Listed in order of severity.

### F-1. Step 1 SHA (Critical C-1) compounds into every batch
If C-1 isn't fixed, Batch 3+ developers can edit `addSessionsKindAndOnsiteColumns` freely without tripping the integrity check. The check will keep returning `ok: true` for the most-mutated SQL in the codebase. The `progress.md` follow-up #5 already flagged the placeholder; this review promotes it to **Critical** because it's the only SQL the integrity check cannot guard.

### F-2. `sessionsDb` doesn't yet know about `kind`
`sessions.db.ts:121-141` (`createSession`) does not pass `kind` or any of the new columns. The schema accepts them, the constraint passes (default `'chat'`), but Batch 4 (WebSocket) and Batch 5.5 (chat e2e) will need to:
- Filter the chat-run-registry by `kind` (REQ-8.7)
- Set `kind='onsite'` when an onsite session is created (REQ-4.1)
- Add `cwd` to the spawn options (REQ-4.1)

The repository will need at least 2 new methods: `createOnsiteSession(...)` and `findOnsiteSessionByCwd(...)`. The current `createSession` shape is right for chat — don't break it. Plan a sibling method, don't overload.

### F-3. `OnsiteWatcher` global listener set will conflict with `initializeSessionsWatcher`
`server/index.js:1778` already calls `initializeSessionsWatcher()` for chat sessions. `onsiteWatcher.ts` has its own module-level singleton (`activeWatcher`, `listeners`). Two independent watchers means two chokidar instances — fine for now, but as both modules grow they should share a small lifecycle helper. Not blocking.

### F-4. `Path.relative` cwd-escape check vs `realpath`
`assertCwdUnderRoot` (`problem.service.ts:80-87`) uses `path.relative` to check escape, which does NOT resolve symlinks. A symlink under `ONSITE_ROOT` pointing to `/etc` would pass the check. For Batch 4 (which writes to problem directories), this becomes exploitable: an attacker-controlled `problem.json` could symlink to outside. Add `fs.realpath` if the threat model includes malicious input. **Batch 5 / WS path-blacklist work makes this more relevant** — write-protection middleware will need to realpath anyway.

### F-5. `onsite-problems.db.ts:32-44` `INSERT_SQL` doesn't enforce CHECK on `status`
`status TEXT NOT NULL DEFAULT 'pending_info'` — no CHECK constraint, no app-layer enum. The TS type union `ProblemStatus = 'pending_info' | 'analyzing' | 'blocked' | 'confirmed' | 'abandoned'` is in `onsite-problems.db.ts:12` but only used as a hint, not enforced. Batch 3 StateMachine will need to validate; consider adding a CHECK constraint or an `assertProblemStatus(value)` helper to the repo.

### F-6. Chat e2e test (Batch 5.5) must verify `kind='chat'` filtering works
Currently the schema permits `kind='onsite'` rows in the `sessions` table but no code path creates them yet. Batch 5.5 needs to verify that:
1. Chat sessions continue to default to `'chat'` (no breakage).
2. The `chat-run-registry.service.ts` kind filter does not match `kind='onsite'` sessions.
3. The `sessions.kind` CHECK constraint doesn't reject chat writes.

The regression baseline (`chat-regression-baseline.txt:1`) shows `78 pass / 1 fail` — that one pre-existing failure (`provider-models.service.test.ts`) is unrelated but will be visible in every diff. Document this in the Batch 5.5 brief so reviewers don't chase a phantom regression.

### F-7. Discipline middleware hook point needs to be chosen now
The `server/modules/websocket/services/onsite-websocket.service.ts` doesn't exist yet (Task 4.x). The four discipline events (`discipline:softening`, `discipline:trace-id-empty`, `discipline:trace-id-suspect`, `discipline:write-protection`) need to be emitted on the WS envelope as a `discipline` field per REQ-8.6. The data model in `onsite_discipline_log` is already in place with `kind` values that match the spec wording, but the actual integration with `chat-websocket.service.ts` (where the Claude message stream is parsed) is the high-risk seam. Recommend: in Batch 4, expose a `discipline.emitProblemEvent(problemId, kind, payload)` helper at the WS service layer so each middleware is decoupled from the WS plumbing.

### F-8. `tsconfig.json` path alias `chokidar` resolution
`config.service.ts:17` and `onsiteWatcher.ts:18` both `import chokidar, { type FSWatcher } from 'chokidar'`. The repo's `package.json` should already have chokidar as a dep; verify it's a peer/dev dependency that's actually installed before Batch 4 hits `server/index.js` on a fresh checkout. (Not blocking; just a verification step.)

---

## Recommendations

### Process

1. **Promote SHA-placeholder follow-up from Minor to Critical**. The `progress.md` review ledger calls it "Minor" — that's wrong. The C-4 fix was the headline improvement in Batch 2, and the placeholder string undermines its central claim. Fix before Batch 3.

2. **Add a "Batch 0~2 integration test" to the CI workflow**. The regression-chat step exists, but there's no end-to-end smoke that exercises `bootstrapConfig` → load onsite route → migrate → runMigrations → insert → repo read. One integration test would catch drift between the four layers.

3. **Lock the schema migration as the first step of every Batch 3+ PR**. Any PR that touches `migrations.ts` should be required to bump a migration name OR run `verifyMigrations` locally and paste the output. Make it a CI check.

### Code

4. **Pre-compute migration SHAs at module-load with a deterministic order**. The current lazy `for (const step of ONSITE_MIGRATION_STEPS) if (!step.sha) step.sha = sha256(step.sql)` (lines 713-717) is fine for step 2–5 (whose `sql` is a module constant), but step 1's `sql` is a placeholder. Either delete step 1 or replace its `sql` with the actual concatenated DDL.

5. **Use `path.normalize` after `path.resolve` in `resolveConfigPath`**. Trivial, prevents downstream surprises.

6. **Add a `countByKind` query to `onsite-discipline-log.db.ts`**. Batch 3 will want to render "this session had 3 softening warnings" in the UI badge — easier to add now than to retrofit.

7. **Tighten the config route test** to assert 503 exactly. Currently it accepts any 5xx; that's too loose.

### Documentation

8. **Add a JSDoc note on `OnsiteWebSocketService` mount point decision**. Task 4.x is unstarted; the design.md (section 1.2) says "新 WebSocket 通道不必" (no new WS channel needed) but `tasks.md` line 38 lists `Create server/modules/websocket/services/onsite-websocket.service.ts` as a Create. These contradict each other. Resolve before Batch 4 starts.

---

## Assessment

**Ready to proceed to Batch 3?** **Yes with caveats.**

**Reasoning**: The 17 commits land a coherent, well-tested foundation: chat regression gate (Batch 0) is solid, config + hot-reload (Batch 1) is correct, and the Batch 2 schema + repos + problem service honor the disk-as-truth design. The C-4 patch (MigrationCorruptionError → process.exit(1)) is real safety net, not ceremony. Tests mostly exercise the code under test rather than smoke-testing imports — the dedup fix (fe49a01) shows the loop is closed. **One Critical** (step 1 SHA placeholder) and **one Important** (config route test brittleness on live JSON) should be fixed in this checkpoint window before Batch 3 mutates the schema. The rest of the Important items are forward-looking and can ship alongside Batch 3 if explicitly tracked.

If C-1 is fixed and the other 8 Important items are carried as known follow-ups (as they already are in `progress.md` for the most part), Batch 3 can start.

---

## Top 3 Findings

1. **Step 1 migration SHA placeholder undermines C-4 integrity check.** `migrations.ts:683-688` hashes a fixed English string instead of the real ALTER statements in `addSessionsKindAndOnsiteColumns`. The integrity check passes silently if the actual SQL drifts. Promote from Minor to Critical and fix before Batch 3.

2. **`config.service.test.ts` parses live config and asserts an exact count.** `assert.equal(cfg.data.customers.length, 13)` will break when a customer is added to `config/customer-analysis.json` (the documented "extend the dropdown" workflow). Reframe as shape assertion.

3. **`regression-chat.sh` Sums `ℹ pass N` lines instead of taking the last value.** The baseline is currently right by accident (one file); with multiple test files the pass count will double-count and produce false-positive diffs against the baseline. The `progress.md` follow-up #2 understates this — promote from Minor to Important.