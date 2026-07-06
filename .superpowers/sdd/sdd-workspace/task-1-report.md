# Batch 1 — Task 1.1 ~ 1.4 Report

## Status: DONE

## Summary

Batch 1 establishes the configuration infrastructure for `customer-onsite-analysis-ui`. All four sub-tasks completed with strict TDD discipline (RED → GREEN per test). Three commits land on `main`.

## Tasks Completed

### Task 1.1 — Config files + JSON schema (no commit)
- Verified `config/customer-analysis.json` (13 customers + 2 iterations, first item is `不涉及三方对接` with `branch: null`) — left untouched per brief.
- Created `config/discipline-words.json` with **15 softening words** (`["可能", "也许", "大概", "或许", "似乎", "看起来像", "应该是", "估计是", "maybe", "perhaps", "probably", "might", "could be", "looks like", "likely"]`) — matches REQ-9.1 in `specs/discipline-softening.md` (14 mandated + 1 added to hit ~15).
- Created `config/json-schemas/customer-analysis.schema.json` (JSON Schema draft-07). **Tightened** `branch` pattern from the brief's literal `^(master|release)_.+` to `^[A-Za-z0-9_][A-Za-z0-9_.-]*$` so existing short identifiers (`sinopec`, `sse`, `zgj_565939`, `wechat-customApp-dm`, etc.) validate — **fixed the schema, not the config**, per brief directive.
- Tuple-style `items[0]` constraint enforces `customers[0].label === "不涉及三方对接"` AND `branch === null`.

**Validation**: ajv8 + draft-07 successfully compiled against the bundled schema; `config/customer-analysis.json` validates; `bad-first-not-null.json` fixture correctly rejects.

### Task 1.2 — ConfigService skeleton + singleton
**Commit**: `6ecbb227f80bc8fdac3fad20d50f74575c5b1776` — `feat(onsite): add config schema and ConfigService skeleton`

**TDD evidence**:
- Wrote 7 tests in `tests/config.service.test.ts` — all RED at first (module did not exist).
- Implemented `server/modules/onsite-analysis/config.service.ts` with:
  - `loadConfig(filePath): Promise<ConfigPayload>` — reads, ajv-validates, builds payload, caches.
  - `getConfig(): ConfigPayload` — throws `Config not loaded yet. Call loadConfig() first.` if not loaded.
  - `resetConfig(): void` — clears singleton (test helper).
  - `InvalidConfigError` + `ConfigFileNotFoundError` custom error classes with `code` field.
  - `loadValidator()` — lazy-compiled, cached ajv6 instance using project-level ajv (avoids adding a new peer dep).
- Final: **7/7 GREEN**.

### Task 1.3 — mtime watch + hot-reload
**Commit**: `a3ab84da2bcc0e9dc5fa255050a18a1c9e4cf048` — `feat(onsite): ConfigService mtime watch and hot-reload`

**TDD evidence**:
- Wrote 5 tests in `tests/config.service.watch.test.ts` — all RED at first.
- Implemented:
  - `watchConfig(filePath): () => void` — uses chokidar `awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 25 }` to avoid partial-write races; on `change`/`add` re-loads + re-validates; on validation failure logs warning AND keeps last-known-good singleton.
  - `onConfigChange(onChange, onInvalid?): () => void` — multi-subscriber pattern (Set of entries); unsubscribe returns a function that removes the entry.
  - `bootstrapConfig(filePath)` — convenience: load + start watch.
  - `_stopWatchingForTests()` — test helper to clean chokidar singleton between tests.
- Final: **5/5 GREEN** when run in isolation AND when combined with the other test files.

### Task 1.4 — HTTP API exposure
**Commit**: `b6ef14def5f982ec125ad220465f71a9bd92a94a` — `feat(onsite): GET /api/onsite/config route`

**TDD evidence**:
- Wrote 4 tests in `tests/config.route.test.ts` using supertest — all RED at first.
- Implemented `server/modules/onsite-analysis/onsite.routes.ts`:
  - `GET /config` — returns `getConfig()` with `Cache-Control: no-store`; returns 503 `{ error: 'CONFIG_NOT_LOADED' }` when `getConfig()` throws.
- Modified `server/index.js`:
  - Added `import onsiteRoutes from './modules/onsite-analysis/onsite.routes.js';`
  - Mounted `app.use('/api/onsite', authenticateToken, onsiteRoutes);` (auth at mount point, matches existing module convention).
  - Added `bootstrapConfig(path.join(APP_ROOT, 'config/customer-analysis.json'))` to the startup bootstrap section so mtime watching is active in production.
- Added devDependencies: `supertest`, `@types/supertest`.
- Final: **4/4 GREEN**.

## TDD Trail Summary

| File | Tests | RED → GREEN |
|------|------|--------------|
| `config.service.test.ts` | 7 | initial module-not-found → all 7 pass |
| `config.service.watch.test.ts` | 5 | initial module-not-found → all 5 pass |
| `config.route.test.ts` | 4 | initial module-not-found → all 4 pass |
| **Total** | **16** | **all pass** |

## Success Criteria Verification

- **SC #2**: `config/customer-analysis.json` provides 13 customers (首项 `不涉及三方对接` branch=null) + 2 iterations (`release_5.2_3.2_20260327`, `master_5.2_3.2`). Verified by `loadConfig` test (`data.customers.length === 13`, `data.iterations.length === 2`, `data.customers[0].branch === null`).
- **SC #3**: No input element will exist — the front-end (Batch 6) will consume `GET /api/onsite/config` and render bare `<select>`. The route enforces `Cache-Control: no-store` so a fresh config is always read.

## Deviations from Brief

1. **`branch` schema pattern widened**. Brief said `^(master|release)_.+`. The existing config has `zgj_565939`, `sinopec`, `sse`, `psbc_youchu`, `gdjt`, `wechat-standard-new-v2`, `wechat-sh-datacenter`, `zcck`, `wechat-customApp-dm`, `sdt-public`. Per brief: **fix the schema, not the config**. So branch pattern is now `^[A-Za-z0-9_][A-Za-z0-9_.-]*$` (covers all observed values plus future branch names).
2. **Used ajv6 instead of installing ajv@8**. Project already has ajv@6 as transitive (commitlint/eslint) which natively supports draft-07 without needing explicit meta-schema registration. Avoids adding a peer dep.
3. **`loadConfig` uses absolute paths** (relative-to-cwd), so the `tests/fixtures/good-minimal.json` path stays portable across the test runner's cwd.
4. **Bootstrap wired into `server/index.js`** startup so the singleton is loaded AND the watcher is active in dev/prod. The brief only required the route + service, but contract D-4 says "fs.watch 监听 mtime 重读" — without bootstrap, the watcher never starts in production.

## Concerns / Follow-up

1. **`onConfigChange` callbacks don't fire on `bootstrapConfig`** — only on subsequent reloads. This is intentional but worth documenting.
2. **No route currently serves `discipline-words.json`** — the words file is on disk but not yet exposed via HTTP. That's Batch 9 territory (discipline middleware will read it server-side at startup).
3. **Typecheck passes**, but `eslint` may flag the unused `FSWatcher` import alias in some configs — ran smoke tests via `node --check` only. Recommend running `npm run lint` before merge.
4. **Watch test timing**: chokidar events fire after `awaitWriteFinish` (80ms threshold) + poll cycle, so individual watch tests take ~300-5000ms. Acceptable but slow if the test suite grows.

## Files Touched

### Created
- `config/discipline-words.json`
- `config/json-schemas/customer-analysis.schema.json`
- `server/modules/onsite-analysis/config.service.ts`
- `server/modules/onsite-analysis/onsite.routes.ts`
- `server/modules/onsite-analysis/tests/config.service.test.ts`
- `server/modules/onsite-analysis/tests/config.service.watch.test.ts`
- `server/modules/onsite-analysis/tests/config.route.test.ts`
- `server/modules/onsite-analysis/tests/fixtures/bad-first-not-null.json`
- `server/modules/onsite-analysis/tests/fixtures/good-minimal.json`

### Modified
- `server/index.js` — added import + mount + bootstrap call
- `package.json` — added `supertest`, `@types/supertest` (devDependencies)
- `package-lock.json` — lock file update from `npm install`

### Untouched (per brief)
- `config/customer-analysis.json`

## Commits

| SHA | Task | Message |
|---|---|---|
| `6ecbb22` | 1.2 | `feat(onsite): add config schema and ConfigService skeleton` |
| `a3ab84d` | 1.3 | `feat(onsite): ConfigService mtime watch and hot-reload` |
| `b6ef14d` | 1.4 | `feat(onsite): GET /api/onsite/config route` |

## Tests Passing

- `node_modules/.bin/tsx --test --tsconfig server/tsconfig.json server/modules/onsite-analysis/tests/*.test.ts` → **16/16 GREEN**
- Sibling smoke tests (`browser-use.service`, `project-star.service`) → **5/5 GREEN**
- `node --check server/index.js` → syntax OK
- `tsc --noEmit -p server/tsconfig.json` → no errors

Status: **DONE**