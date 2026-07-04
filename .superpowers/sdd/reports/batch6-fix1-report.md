# Batch 6 Fix 1 — C1 + I1 + I2

**Status: PASS**

Batch 6 reviewer flagged 1 Critical (shared type ↔ server shape mismatch) and
2 Important (never-written `auth-user` localStorage key; misnamed "hooks") issues.
All three are fixed in a single commit on `main`; no chat-path file was touched;
client `tsc` is clean.

## Files modified

| File | Lines (add/remove) | Reason |
|---|---|---|
| `shared/onsite-types.ts` | +12 / -12 | **C1** — switch `ProblemRecord` + `OnsiteFile` + `UploadResult` to snake_case to match the wire format returned by `server/modules/onsite-analysis/problem.service.ts:getById` (`third_bridge_branch`, `problem_json_path`, `root_cause_text`, `created_at`) and `onsite-files.db.ts` (`original_name`, `stored_path`, `unpacked_dir`, `uploaded_at`). |
| `src/contexts/OnsiteWebSocketContext.tsx` | +21 / -6 | **I1** — `readUserIdFromLocalStorage` now decodes the JWT payload from the canonical `auth-token` localStorage key (base64url → atob) and reads `sub` (fallback `id`) instead of an `auth-user` JSON blob that is never written. |
| `src/stores/onsiteStore.tsx` | +13 / -13 | **I2** — rename the three snapshot-read selectors `useProblem` → `getProblem`, `useUploadProgress` → `getUploadProgress`, `useAnyUploading` → `getAnyUploading` (interface, definition, and exposed return). The `use` prefix was a misnomer; none of them call React hooks or subscribe. |

`git show --stat cd901cc`:

```
 shared/onsite-types.ts                  | 24 +++++++++++++-----------
 src/contexts/OnsiteWebSocketContext.tsx | 27 +++++++++++++++++++++------
 src/stores/onsiteStore.tsx              | 26 +++++++++++++-------------
 3 files changed, 47 insertions(+), 30 deletions(-)
```

## Commit

- **Hash:** `cd901cc980bc4ed7289b99c0f1d9dc347762a9e6`
- **Message:** `fix(onsite): align shared types to snake_case + auth token lookup + selector naming`
- **Branch:** `main`
- **Parents:** `1f1fcf2` (Batch 6 final — `feat(onsite): route + sidebar entry (Task 6.4)`)
- **Working tree after commit:** clean (`git diff HEAD --stat` empty)

## Client tsc output

```
$ npx tsc --noEmit -p tsconfig.json
$ echo $?
0
```

**Exit 0, zero output, zero warnings.** No downstream type breakage from the
renames; only the three target files import from `shared/onsite-types.ts`, and
they all use the snake_case fields via the new interface (no consumer code
reads the renamed fields — Batch 7 hasn't been written yet).

## Chat-path zero-regression check (5 files)

```
$ git diff f1e6bb4 HEAD --stat -- \
    src/contexts/WebSocketContext.tsx \
    src/stores/useSessionStore.ts \
    server/claude-sdk.js \
    server/modules/websocket/services/chat-run-registry.service.ts \
    server/modules/websocket/services/chat-websocket.service.ts
(empty — zero diff)
```

Confirmed: `git diff` between the chat-path gate baseline (`f1e6bb4`) and
current `HEAD` is **empty** for all 5 protected files. The fix commit only
touches the three onsite-only files listed above.

## Batch 7 selector callers — none yet

```
$ grep -rn "store\.useProblem\|store\.useUploadProgress\|store\.useAnyUploading" src/
(no matches)

$ grep -rn "getProblem\|getUploadProgress\|getAnyUploading" src/ server/ shared/
shared/onsite-types.ts: <none>
src/stores/onsiteStore.tsx: 12 hits (interface + definition + exposed return — internal)
```

The renamed selectors (`getProblem` / `getUploadProgress` / `getAnyUploading`)
are only defined and exposed by `onsiteStore.tsx`. **No consumer exists yet** —
Batch 7 will be the first to call them, so the rename is safe and self-contained.
No cascading-callers update was needed (per the brief's rule: "don't update them;
confirm via grep that there are no callers yet").

## Cross-references verified against server source

Per the brief's "校验源" list, the new field names match the server payload
shape exactly:

- `server/modules/onsite-analysis/problem.service.ts:226-239` — `getById` returns `{ third_bridge_branch, problem_json_path, ... }`
- `server/modules/database/repositories/onsite-problems.db.ts` — `OnsiteProblemRecord` uses snake_case for all columns including `created_at`, `root_cause_text`
- `server/modules/database/repositories/onsite-files.db.ts` — `OnsiteFileRecord` uses `original_name`, `stored_path`, `unpacked_dir`, `uploaded_at`
- `server/modules/onsite-analysis/onsite.routes.ts:211-223` — `GET /problems/:id` returns the raw snake_case record via `res.json(record)`
- `server/modules/onsite-analysis/onsite.routes.ts:374` — `confirm-root-cause` returns `{ ...result, root_cause_text }`

The shared type's docstring was updated to cite the server source explicitly so
the next reader sees the wire-format contract.

## Acceptance checklist

- [x] C1 — `shared/onsite-types.ts` fields now match server wire format (snake_case)
- [x] I1 — `auth-user` read replaced with JWT `sub`/`id` decode from canonical `auth-token`
- [x] I2 — selectors renamed to drop misleading `use` prefix; interface + impl + return updated
- [x] Zero backend changes
- [x] Zero chat-path file changes (5 files verified empty diff vs `f1e6bb4`)
- [x] `npx tsc --noEmit -p tsconfig.json` exits 0 with no output
- [x] Single commit, message matches the brief exactly
- [x] No Batch 7 callers to chase (grep confirmed)

## Notes for Batch 7

- The store's exposed surface is now `{ problems, config, currentProblemId, uploading, lastError, lastFetchedAt, loadConfig, loadProblems, selectProblem, patchStatus, uploadFiles, getProblem, getUploadProgress, getAnyUploading }`. Use `getProblem(id)` / `getUploadProgress(id)` / `getAnyUploading()` — not the old `use*` names.
- All `ProblemRecord` / `OnsiteFile` / `UploadResult` field accesses must use snake_case. TypeScript will guide you; the strings match what the server `res.json(...)` emits verbatim — no client-side normalizer needed.
- `userId` in the WS hello frame is now reliably populated (decoded from the active JWT at provider-mount time), so server-side audit logs in `chat-run-registry` will be able to tag discipline events with the actual user.
