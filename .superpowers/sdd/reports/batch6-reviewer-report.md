# Batch 6 Reviewer Report — 前端基础设施

**Verdict: HOLD_FOR_FIX**

Batch 6 successfully delivers a working frontend infrastructure plumbing layer (shared types, store, WS context, i18n, route, sidebar entry) and is **not blocked** by any chat-path regression. However, the shared TypeScript types **do not match the actual API JSON shape** the server returns — a critical alignment gap that will surface as runtime `undefined` accesses in Batch 7 unless fixed. One other Important issue + a handful of Minor items are also flagged.

**Independently verified (no trust in implementer report):**
- Client `npx tsc --noEmit -p tsconfig.json` → exit 0, no output
- 5 chat-path files → empty diff vs f1e6bb4
- Server `npx tsc --noEmit -p server/tsconfig.json` → 30 errors on HEAD, 30 errors on f1e6bb4 — **0 introduced by Batch 6** (implementer reported "14" but the direction is correct; see §H notes)

---

## Critical issues (1)

### C1. `shared/onsite-types.ts` declares `ProblemRecord` with camelCase fields that the server does NOT return

**File:** `shared/onsite-types.ts:36-50` (definition) vs `server/modules/onsite-analysis/problem.service.ts:226-239` and `server/modules/onsite-analysis/onsite.routes.ts:211-223` (production response shape).

The shared type declares:
```ts
export interface ProblemRecord {
  id: string;
  customer: string;
  thirdBridgeBranch: string | null;   // <-- camelCase
  iteration: string;
  database: string;
  status: ProblemStatus;
  cwd: string;
  problemJsonPath: string | null;     // <-- camelCase
  createdAt?: string;
  rootCauseText?: string | null;      // <-- camelCase
}
```

The server `GET /api/onsite/problems` and `GET /api/onsite/problems/:id` return `res.json(record)` where `record` is the raw DB row (snake_case from `onsiteProblemsDb.findById` / `problem.service.ts:226-239`):
```json
{ "id": "...", "customer": "...", "third_bridge_branch": null, "iteration": "...",
  "database": "...", "status": "pending_info", "cwd": "...",
  "problem_json_path": null }
```

`POST /api/onsite/problems/:id/confirm-root-cause` returns `{ ...result, root_cause_text: ... }` (`onsite.routes.ts:374`).

**Impact at runtime:** Batch 7 will read `problem.thirdBridgeBranch`, `problem.problemJsonPath`, `problem.rootCauseText` and get `undefined` for every record — the third-party branch is needed to display the wizard hint, and `problemJsonPath` is referenced in the shared docstring. TypeScript can't catch this because both sides are typed locally; the mismatch only manifests when JSON is parsed.

**Reproduction:**
```bash
# Run the dev server, hit the endpoint, dump the response:
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/onsite/problems
# Observe: third_bridge_branch (snake), problem_json_path (snake)
# Now check the type Batch 7 will write against:
grep -A2 "thirdBridgeBranch\|problemJsonPath\|rootCauseText" shared/onsite-types.ts
```

**Fix options** (any one):
1. Change the shared type to snake_case (e.g. `third_bridge_branch: string | null`) — matches the wire format verbatim; no transform needed.
2. Keep camelCase and add a normalizer in `onsiteStore.loadProblems` that translates server → client shape (one `toCamel` helper).
3. Have the server add a response-transform middleware that emits camelCase (larger blast radius, affects all routes).

Recommend (1) for minimal scope — the contract says "shared/onsite-types.ts mirrors `/api/onsite/*` REST responses", and the actual responses are snake_case.

---

## Important issues (2)

### I1. `userId` lookup reads `localStorage['auth-user']` which is never written anywhere in the codebase

**File:** `src/contexts/OnsiteWebSocketContext.tsx:268-281` (function `readUserIdFromLocalStorage`).

Grep over the entire `src/` and `server/` trees shows:
- `auth-token` IS the canonical localStorage key (constant in `src/components/auth/constants.ts:1` as `AUTH_TOKEN_STORAGE_KEY`, set in `src/utils/api.js:27` and `src/components/file-tree/hooks/useFileTreeUpload.ts:135`).
- `auth-user` is **never set anywhere** (only read here).
- The current user is held in React Context (`AuthContext.tsx:38`) and JWT, not in localStorage.

**Impact:** Every onsite WS hello frame will carry `userId: null`. The server's `validateOnsiteHelloFrame` accepts null (so the connection still works), but the server-side audit log for batch 4/5 discipline events won't tag the user — silently degrades the audit trail.

**Fix:** Read the user from the JWT payload (decode `auth-token` in the browser — it's just a base64url body, no signature check needed client-side) OR expose the user through a hook from `AuthContext` and pass it into `OnsiteWebSocketProvider` as a prop. A 5-line fix in this batch or a pre-agreed follow-up for Batch 7 is acceptable; the implementer already flagged this in their §7-Q6.

### I2. `useProblem` / `useUploadProgress` / `useAnyUploading` are misnamed as React hooks but are plain functions

**File:** `src/stores/onsiteStore.tsx:253-268`.

These are defined as `useCallback` (so their identity is stable) but they **do not call any React hook** and do not subscribe. They read `stateRef.current` at call time. This works only if the consumer already called `useOnsiteStore()` (which subscribes via `setTick`) at the top of the same component. Calling `store.useProblem(id)` in isolation from a child will not re-render on data change.

**Impact:** Confusing for Batch 7. The implementer is aware (see their §7-Q1) and offers a 5-line refactor to `useSyncExternalStore`. Recommend Batch 7 implementer pick one:
- (a) Rename the methods to `getProblem(id)` / `getUploadProgress(id)` / `getAnyUploading()` (drop the `use` prefix) — matches what they actually do.
- (b) Convert them to real `useSyncExternalStore` hooks so consumers can call them from any depth.

**Reproduction:**
```bash
grep -n "useCallback" src/stores/onsiteStore.tsx | head -10
# observe: useProblem, useUploadProgress, useAnyUploading — none call useState/useEffect/etc.
```

---

## Minor / note for later

1. **Protocol errors are silently dropped.** Server can send `{ kind: 'protocol_error', code, error, timestamp }` (e.g. `HELLO_TIMEOUT`, `HELLO_INVALID`) but `handleServerEvent` only dispatches `problems:changed` and `problem:<id>:state-changed`. Batch 7 should consider surfacing this through a toast or a connection-status indicator. (Source: `onsite-websocket.service.ts:144-153`, `OnsiteWebSocketContext.tsx:130-154`.)

2. **`state-changed` reload strategy.** Implementer's §7-Q2 — calling `loadProblems()` on every `problem:<id>:state-changed` is fine for low-frequency events but is `O(n)` over the full list. If WS push frequency grows, consider an in-place patch. Not a blocker for Batch 7.

3. **Implementer's error count was wrong (14 vs actual 30).** The §3 of the report lists exactly 14 errors but `npx tsc -p server/tsconfig.json` shows 30. The *direction* of the claim (0 introduced by Batch 6) is correct — independent re-run on f1e6bb4 gives the same 30 errors. Just a count mistake in the report; flagging so the next implementer doesn't reference the wrong number.

4. **`useParams<{ problemId?: string }>()` in `OnsiteLayout.tsx:17` works for both `/onsite` (problemId undefined) and `/onsite/:problemId`, but the dev server smoke test couldn't be reproduced in this reviewer's sandbox (vite exited silently with no log output — sandbox issue, not a code issue). The implementer's reported 200/200/200 stands; the route registration was independently confirmed by reading `App.tsx:122-123`.

5. **Server-side `lastActivityAt` is mentioned in the shared type's `ProblemListItem` docstring (`onsite-types.ts:53-55`) but `ProblemListItem` is defined as `type ProblemListItem = ProblemRecord` — no extra field. The brief used this term but the server doesn't actually return it (sort stability is from `created_at DESC, id DESC` in the DB). Cosmetic.

6. **`PatchStatus` body.** Client sends `{ status, reason }` (`onsiteStore.tsx:156`). Server accepts that and defaults `actorId` to `null` (`onsite.routes.ts:253-256`). No client-side `actor_id` field needed, but downstream consumers can't know who initiated a transition from the audit log alone. Worth a follow-up to thread the JWT subject as `actor_id`.

7. **`OnsiteLayout` is a proper placeholder** with `data-testid="onsite-layout-placeholder"` and surfaces the selected `problemId`. Batch 7 can replace it without coordination.

8. **Mobile sidebar entry intentionally skipped** (per implementer's §7-Q4 and `AppContent.tsx:203-229`). Mobile users navigate via URL bar. Pre-agreed.

---

## Strengths

- **TDD iron-law honesty:** No fake test files were invented. The brief's adapted TDD matrix (failed-first signal = tsc error; pass signal = tsc clean) is honestly executed and the implementer called it out as a deviation in §5.
- **Clean chat-path boundary:** Five critical files have zero diff vs f1e6bb4. WS provider is a separate singleton on `/onsite/ws`, not piggybacked onto `/ws`. Discipline middleware isolation is preserved (server's `enabledFor(ws) === true` check stays valid).
- **Exponential backoff math is correct:** `min(30000, prev * 2 + jitter)` with `INITIAL=1000`, reset on success, cleanup on unmount, and `clearTimeout` on token-change. Sequence matches brief: ~1s, ~2s, ~4s, ~8s, ~16s, then capped at 30s.
- **i18n parity:** `jq` confirms identical key sets in zh-CN and en, all non-empty. Key names follow the brief's §3 contract (`nav.onsite`, `wizard.*`, `status.*`, `error.*`, `discipline.*`, `common.*`).
- **Vite proxy is additive:** `/ws` unchanged, `/onsite/ws` purely added. `@shared` alias additive to existing `@`. No rename, no risk to existing chat proxy.
- **Store re-render pattern matches `useSessionStore.ts`:** `useRef` + `setTick` is the right shape given "no new deps" rule; zustand → hooks deviation is well-justified.
- **`OnsiteLayout` is a real placeholder** with a stable `data-testid`, so Batch 7 has a clear hand-off marker.
- **Zero server-side regressions:** 30 → 30 errors on the server tsconfig (full diff confirmed; see §H).

---

## Cross-cutting verification table

| § | Check | Result | Notes |
|---|---|---|---|
| **A** | Client tsc clean | **PASS** | `npx tsc --noEmit -p tsconfig.json` → exit 0, no output |
| **B** | Shared types align with server schema | **FAIL** | `ProblemRecord` is camelCase; server returns snake_case (Critical C1) |
| **C** | WS exponential backoff math | **PASS** | Formula `min(30s, prev*2 + jitter)`, initial 1s, reset on success, cleanup on unmount. Sequence: 1, 2, 4, 8, 16, 30, 30... |
| **D** | Routes + sidebar mount | **PASS** | `/onsite` and `/onsite/:problemId` registered; `OnsiteWebSocketProvider` mounted outside Router; NavButton only on desktop as declared |
| **E** | i18n key parity | **PASS** | `jq -S 'keys'` diff: identical. No empty strings. |
| **F** | Chat path zero regression | **PASS** | 5 critical files empty diff vs f1e6bb4 |
| **G** | Vite proxy doesn't break chat | **PASS** | `/ws` unchanged; `/onsite/ws` additive; `@shared` alias additive |
| **H** | Pre-existing server tsc errors | **PASS (with note)** | 30 errors on HEAD, 30 on f1e6bb4 — 0 introduced. Implementer reported "14" (count off, direction correct) |
| **I** | Dev server smoke (200/200/200) | **NEEDS_CONTEXT** | Vite exited silently in reviewer sandbox (likely sandbox block); implementer reported success; route registration independently confirmed via App.tsx reading |
| **J** | Open questions addressed | **PASS with 1 Important** | Q1 (selectors) → flagged I2; Q6 (userId key) → flagged I1; rest are non-blocking design choices |

---

## Forward compatibility for Batch 7

**Required before Batch 7 starts coding (because C1 will break typing assumptions):**

1. **Fix C1 first.** Either:
   - Change `shared/onsite-types.ts` to snake_case (`third_bridge_branch`, `problem_json_path`, `root_cause_text`), OR
   - Add a `toClient(record: any): ProblemRecord` helper in `onsiteStore.loadProblems` and apply it in the parse step.
   - Either approach is ≤ 10 lines. The first is preferred — the shared file already has a docstring saying it "mirrors the API response" and that promise should be kept literally.

**Strong recommendations (not blocking but will save Batch 7 cycles):**

2. **I1 — userId wiring.** Pick a source: decode `auth-token` JWT, or expose `useAuthUser()` from `AuthContext` and pass into `OnsiteWebSocketProvider`. 5-line fix in this batch or first commit of Batch 7.
3. **I2 — selector naming.** Decide between (a) `getProblem(id)` rename or (b) `useSyncExternalStore` upgrade. Either way Batch 7 will write against the chosen shape.

**Non-blocking notes (Batch 7 can defer):**

4. Protocol-error surfacing (toast / connection-status indicator).
5. `actor_id` threading in `patchStatus` (use JWT sub).
6. Mobile sidebar parity.
7. State-changed in-place patch if WS push frequency grows.

**Batch 7 will be unblocked once C1 is fixed.** The shared types are the only direct dependency — I1, I2 are ergonomic concerns, not blockers.
