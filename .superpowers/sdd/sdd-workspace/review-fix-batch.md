# Review — Fix Batch (8 commits after Checkpoint Review)

**Reviewer**: Senior Code Reviewer (fresh perspective, did not author or pre-approve)
**Range reviewed**: `72c8725..65f25b5` (8 commits)
**Test result (re-run)**: 157 pass / 1 fail — only the pre-existing `provider-models.service.test.ts` failure remains (matches brief)
**Verdict**: ✅ **Ready to proceed to Batch 3**

## Per-Fix Verification

### C-1 — Delete step 1 SHA placeholder
- Status: ✅ Correct
- Notes: `migrations.ts:711-732` now exports a 4-element `ONSITE_MIGRATION_STEPS` array (`002_…`, `003_…`, `004_…`, `005_…`). No placeholder English string, no `sha: ''` literal at the array level (the lazy SHA fill loop at lines 737-741 still computes SHAs at module load). JSDoc at `migrations.ts:540-547` and `migrations.ts:617-621` explains exactly why `addSessionsKindAndOnsiteColumns` is excluded from SHA tracking. `onsite-migration.test.ts:134-156` adds three new tests pinning the new shape (length === 4, no `001_*` name, every sha is a non-empty 64-char hex). `migration-rollback.test.ts:107-115,189` updated to the new baseline. Verified by re-running tests: 4-step shape holds.

### I-1 — regression-chat.sh last-value parsing
- Status: ✅ Correct
- Notes: `regression-chat.sh:160-173` now uses `grep -E '^ℹ +pass' "$TMP_OUT" | tail -n1 | awk '{ gsub(...); print $NF+0 }'` for all three metrics (pass/fail/tests). Comments now spell out the double-count failure mode the previous `awk sum` had. `regression-chat.test.ts:111-216` adds a multi-line TAP fixture test that asserts BOTH that the old sum-bug approach gives `PASS=19 TESTS=21` and that the new last-value approach gives `PASS=11 TESTS=13` — i.e. the test would fail loudly if either side regressed. The test also greps the actual script for any remaining `sum += $NF ... END { print sum+0 }` pattern, providing a real regression guard.

### I-3 — resolveConfigPath 加 path.normalize
- Status: ✅ Correct (with minor smell — see Issues)
- Notes: `config.service.ts:72-79` wraps `path.resolve` with `path.normalize`. `config.service.test.ts:118-167` adds three concrete cases: relative `./foo/bar.json`, relative `./foo/../bar.json`, and absolute `/foo/bar/./baz/../cfg.json` — each asserts both the expected normalized form AND absence of `/./` or `..` segments. Tests are real, not smoke. **Minor**: the exported `resolveConfigPath` (lines 89-91) is a thin pass-through to the unexported `resolveConfigPathImpl`; `loadConfig` at line 122 still calls the impl directly, so the export is effectively test-only. Not wrong, just slight asymmetry.

### I-5 — Tighten config route test to 503
- Status: ✅ Correct
- Notes: `config.route.test.ts:81-95` changes `assert.ok(response.status >= 500 && response.status < 600)` to `assert.equal(response.status, 503, …)`. Comment explains the rationale (silent regression to 500/502/504 should now fail loudly). No other test behavior touched. Confirmed against `config.service.ts:loadConfig` and the reset flow: the route genuinely returns 503 on `resetConfig()` + un-bootstrapped state.

### I-6 — rename updateStatus → updateStatusOnly
- Status: ✅ Correct
- Notes: `onsite-problems.db.ts:96-99` (new method) drops `_reason` / `_actorId` and the JSDoc explicitly documents the audit-by-caller contract. `onsite-problems.db.test.ts:107,135` updated to call the new name; line 116-118 has a new test that asserts `.length === 2` (the "exactly (id, status) — no extra audit params" guard). Grep for `updateStatus` (no `Only`) across `server/` and the wider repo: no orphaned call sites. The remaining `updateStatus` strings in `onsite-problems.db.test.ts` are test names and a `JSDoc`/`/* I-6 fix: … */` comment that mention the legacy name for history — no real call sites use the old name. **Real TDD**: the `.length === 2` test would catch anyone re-introducing the dead params.

### I-9 — sessionsDb app-layer assertSessionKind + new helpers
- Status: ✅ Correct (with one real test-strength concern — see Issues)
- Notes: `sessions.db.ts:26-65` adds `SessionKind` type, `InvalidSessionKindError` (with `code: 'INVALID_SESSION_KIND'` and `kind` field for `instanceof` discrimination), and `assertSessionKind(value)` (TS `asserts` predicate). Both `createSession` (line 143) and `createAppSession` (line 224) now call `assertSessionKind('chat')` at the top. `createOnsiteSession(...)` at lines 252-285 inserts `kind='onsite'` row with `cwd`/`third_bridge_branch`/`iteration`/`database` populated. `findOnsiteSessionByCwd(cwd)` at lines 287-304 queries `WHERE kind='onsite' AND cwd=?` ordered by `updated_at DESC`. `sessions-kind.test.ts:181` covers all paths. **Concern**: see Important-1 below — the "kind 列存为 onsite" test name over-promises vs what it actually asserts (no `kind` column is selected by `SESSION_ROW_COLUMNS`).

### Date test fix — `todayYyyymmdd()` helper
- Status: ✅ Correct
- Notes: `problem.service.test.ts:63-70` adds a `todayYyyymmdd()` helper using `getFullYear()`, `getMonth() + 1`, `getDate()` with `padStart(2, '0')`. `problem.service.ts:255-260` uses the exact same three lines. The two previously-failing tests at lines 73-103 and 96-148 both now derive the date dynamically. No semantic change to test intent — only the hard-coded `20260703` is replaced. Comment at lines 60-62 documents the mirror-implementation rationale.

### Baseline rewrite — `chat-regression-baseline.txt`
- Status: ✅ Correct
- Notes: Old: `696fc5a5b0a06c3c8eaa3dd960557bb07bcfd654 2026-07-03T11:23:06Z 78 1 8862`. New: `f931c8345a89fd0e8a1e312949da11c7575ecf43 2026-07-04T02:47:09Z 157 1 34434`. The new SHA `f931c83` corresponds to commit `docs(sdd): progress.md 整理 + fix-batch-2 review report` — verified via `git log`. Format `<sha> <iso_date> <pass> <fail> <elapsed_ms>` matches the contract documented in `regression-chat.sh:10,60`. The 157 / 1 numbers match the re-run test result above (157 pass, 1 pre-existing fail).

### progress.md update
- Status: ✅ Correct
- Notes: `progress.md` adds rows for `Task 2.fix.review.1` through `.6` (lines 21-26) with each commit SHA. C-1 promoted to Critical under "批 2 后" follow-up table (lines 41-46). I-2 (`CRITICAL_PATTERNS` sessions path slash) is explicitly struck through at line 111 with rationale: "case-statement 展开依赖全字匹配 `server/modules/database/repositories/sessions*.ts`,无需修改". I-4 and I-8 moved into a new explicit "Deferred with rationale" subsection (lines 84-92). I-1 removed from Important-4 follow-up at line 123 (struck through). Follow-up table counts updated (4→3 Important, 7→6 Minor). Self-consistent with the actual code state.

## Strengths

- **Real TDD discipline**: the new tests are concrete — `regression-chat.test.ts:142-176` builds a TAP fixture and verifies BOTH the old and new parsing approaches produce the expected numbers. `config.service.test.ts:118-167` tests three concrete path-normalization cases with both positive and negative assertions. `onsite-problems.db.test.ts:151-154` pins `.length === 2` so any re-introduction of dead audit params would fail loudly. `onsite-migration.test.ts:153-157` enforces non-empty hex64 SHAs.
- **Self-documenting code**: the JSDoc on `migrations.ts:540-547`, `verifyMigrations:617-621`, `updateStatusOnly:86-98`, `createOnsiteSession:240-251`, and `findOnsiteSessionByCwd:286-291` all explain *why* the design is what it is, not just *what* it does. Forward-looking context (Batch 3 / Batch 4 / Batch 5.5) is called out in `sessions.db.ts:18-24`.
- **Defensive progress.md**: I-2 is explicitly struck through with the reasoning that made the original reviewer wrong ("case-statement 展开依赖全字匹配"). This is exactly the "don't trust the prior reviewer" discipline a follow-up review should exhibit, and it cleanly prevents this finding from being re-raised in a future review.
- **Test count regression is real**: 154 → 157 pass (3 more tests added, all new tests are real). 1 pre-existing failure is preserved.
- **All call sites updated**: `updateStatus` is fully removed from the production code; only its name appears in 2 test names + 1 history comment (no orphans).
- **findOnsiteSessionByCwd is well-typed**: returns `SessionRow | null` (not `any`), and the SQL projection uses the existing `SESSION_ROW_COLUMNS` constant. Reuses the existing `normalizeSessionRow` for shape consistency with other reads.

## Issues

### Critical (must fix before Batch 3)
- *(none)*

### Important (fix soon)

1. **`sessions-kind.test.ts:105-120` test name over-promises vs assertion** — the test is titled "kind 列存为 onsite(直接查 DB)" but the only DB read uses `sessionsDb.getSessionsByProjectPath` which only projects `SESSION_ROW_COLUMNS` (which does NOT include `kind`/`cwd`/`third_bridge_branch`/`iteration`/`database` per `sessions.db.ts:80-81`). It only asserts the row exists and `session_id` matches. Same weakness in the "createOnsiteSession 写入 kind=onsite + cwd + ..." test (line 84-103): the comment on line 96-97 says "sessionsDb.getSessionById doesn't expose kind/cwd/... yet because chat-side readers don't need them" — but the test name claims it does, and the I-9 contract hinges on the `kind` and `cwd` columns being correctly populated. **Fix**: add a helper like `readRawKind(sid)` that runs a one-off `SELECT kind, cwd, third_bridge_branch, iteration, database FROM sessions WHERE session_id=?` against the underlying `getConnection()`, and use it in the two tests. This is a 5-10 line test-only addition that materially strengthens the I-9 contract verification. The test file even has `getConnection` imported via `connection.js`, so the import is already there.

### Minor (note for later)

1. **`config.service.ts:81-91` exported `resolveConfigPath` is a thin pass-through to `resolveConfigPathImpl`** — `loadConfig` at line 122 still calls the impl directly. Not wrong, but the JSDoc on the exported one ("the double normalize is intentional") is misleading because (a) there is no double normalize, and (b) the production code path doesn't even use the exported one. Either inline them or have `loadConfig` use the exported one for a single source of truth.
2. **`onsite-problems.db.test.ts:8,101` still mention `updateStatus` in test name / JSDoc header**. The test name is misleading after the rename. Cosmetic only.
3. **`progress.md:111-114` strikethrough on I-2** uses Markdown `~~…~~` which renders in many viewers but the table cell is narrow. A normal reader might miss the rationale. Could be moved to a "Resolved" sub-section.
4. **`regression-chat.test.ts:165` uses `require('node:fs')` inside the test** for `unlinkSync` — fine in a finally block, but the file already imports from `node:fs/promises` at the top. Style-only.

## Forward Compatibility

**Batch 3 (StateMachine) is unblocked**:
- `updateStatusOnly(id, status)` (`onsite-problems.db.ts:99-103`) explicitly hands off audit-row writing to the caller, with JSDoc pointing to `onsiteStateAuditDb.append(...)` and the "ideally inside the same `db.transaction(...)` wrapper" hint. The StateMachine can wrap both writes atomically.
- `addSessionsKindAndOnsiteColumns` (excluded from SHA tracking) is no longer a forward-looking risk; the JSDoc explains why.
- `verifyMigrations` scope doc (lines 617-621) makes the integrity-check contract explicit for anyone adding Batch 3+ migrations.

**Batch 4 (WebSocket + child-spawn) is unblocked**:
- `createOnsiteSession(...)` (`sessions.db.ts:252-285`) is the direct insertion API Batch 4 needs; signature takes the four `OnsiteSessionOptions` fields and writes a `kind='onsite'` row atomically.
- `findOnsiteSessionByCwd(cwd)` (`sessions.db.ts:287-304`) gives Batch 4 a "is there already an active onsite session for this cwd?" lookup with `ORDER BY updated_at DESC` for the latest-wins semantics. The "latest session" lookup returns `SessionRow | null`, matching the type other readers use.
- `assertSessionKind('onsite')` guard at the top of `createOnsiteSession` means upgraded DBs without the schema CHECK will still reject stray values.

**Batch 5.5 (chat e2e)**:
- `assertSessionKind` is exported so chat e2e can pin the invariant independently of the repo layer.
- The `kind='chat'` filtering (now actively enforced at the write boundary) means chat e2e can rely on the registry to return only chat rows.

**No new forward-looking risks created by these fixes** that I can identify. The only sub-100%-strong contract is the `kind`/`cwd` column assertion gap in the tests (see Important-1 above) — and that's a test-strength issue, not a code defect.

## Assessment

**Ready to proceed to Batch 3?** **Yes** (with the I-9 test-strength caveat recommended for follow-up in Batch 3+ rather than a blocker).

**Reasoning**: All 8 fixes (C-1, I-1, I-3, I-5, I-6, I-9, date, baseline) implement what their commit messages claim, and the new tests are concrete enough to catch regressions — the only Important issue is a test-strength gap on `createOnsiteSession` (the test name implies a `kind`/`cwd` column check that the current `SESSION_ROW_COLUMNS` projection does not enable). This is fixable in a follow-up and does not block Batch 3 work, since the production code itself is correct (the INSERT statement explicitly writes `'onsite'` and the four options). The pre-existing `provider-models.service.test.ts` failure is unrelated and pre-dates this batch.

**Recommended next actions** (not blockers):
1. Add a `SELECT kind, cwd, third_bridge_branch, iteration, database FROM sessions WHERE session_id=?` test-only helper and use it in `sessions-kind.test.ts:84-103, 105-120` to actually assert the column values (5-10 lines, ~1 PR).
2. Decide whether to keep both `resolveConfigPath` and `resolveConfigPathImpl` or collapse to a single export (1-line refactor).
3. Rename the two `updateStatus`-named tests in `onsite-problems.db.test.ts` to use the new `updateStatusOnly` name (cosmetic, but the current names will mislead future readers).
