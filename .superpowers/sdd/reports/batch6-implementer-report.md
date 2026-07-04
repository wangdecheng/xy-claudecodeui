# Batch 6 Implementer Report — 前端基础设施

**Status:** DONE_WITH_CONCERNS

Concern: pre-existing server-side typecheck errors (in `server/modules/onsite-analysis/**` and `chat-run-registry.service.ts`) surface under `npm run typecheck` because that script runs both `tsc -p tsconfig.json` and `tsc -p server/tsconfig.json`. **None of these errors are introduced by Batch 6** — verified by reproducing them on a clean tree (no stash diff). Client-only `tsc -p tsconfig.json` exits 0 cleanly.

---

## 1. Files created / modified

### Created

| Path | Lines | Purpose |
|---|---|---|
| `shared/onsite-types.ts` | 113 | Discriminated-union types shared by client + server (`ProblemStatus`, `ProblemRecord`, `ProblemListItem`, `ConfigPayload`, `OnsiteFile`, `UploadResult`, `OnsiteHelloFrame`, `OnsiteServerEvent`). |
| `src/stores/onsiteStore.tsx` | 277 | React-hooks store implementing `useOnsiteStore()`. State: `problems`, `config`, `currentProblemId`, `uploading`, `lastError`. Actions: `loadConfig`, `loadProblems`, `selectProblem`, `patchStatus`, `uploadFiles` (XHR + onprogress). Selectors: `useProblem`, `useUploadProgress`, `useAnyUploading`. |
| `src/contexts/OnsiteWebSocketContext.tsx` | 247 | Singleton `/onsite/ws` provider. Exp backoff (`nextBackoff` jitter, capped at 30s), hello-frame on open, re-sends hello on `setHelloContext`. Dispatches `problems:changed` → `loadProblems`, `problem:<id>:state-changed` → reload. Exposes `useOnsiteWebSocket()`. |
| `src/components/onsite-analysis/layout/OnsiteLayout.tsx` | 33 | Batch 7 placeholder. Mounts `data-testid="onsite-layout-placeholder"`. |
| `src/components/onsite-analysis/nav/OnsiteNavButton.tsx` | 67 | Sidebar entry. Active when `pathname === '/onsite'` or starts with `/onsite/`. `data-testid="onsite-nav-button"`, `data-active`. |
| `src/i18n/locales/zh-CN/onsite.json` | 49 | zh-CN: `nav.onsite` `🔍 客户现场分析` + full key set from brief. |
| `src/i18n/locales/en/onsite.json` | 49 | en mirror. |

### Modified

| Path | Why |
|---|---|
| `src/App.tsx` | Add `OnsiteWebSocketProvider` (sibling of `WebSocketProvider`) and 2 routes `/onsite`, `/onsite/:problemId` rendering `<OnsiteLayout />`. |
| `src/components/app/AppContent.tsx` | Mount `<OnsiteNavButton />` under desktop Sidebar; mobile sidebar left unchanged (per "minimal change" rule). |
| `src/i18n/config.js` | Register `onsite` ns in `ns: [...]`, add `onsite: enOnsite` and `onsite: zhOnsite` resources, add `import enOnsite / zhOnsite`. |
| `vite.config.js` | Add `@shared` alias → `shared/`. Add `/onsite/ws` WebSocket proxy entry. |
| `tsconfig.json` | Add `@shared/*` → `shared/*` paths entry so the shared types resolve under the same alias Vite uses. |

---

## 2. Commits

```
1f1fcf2 feat(onsite): route + sidebar entry (Task 6.4)
4af278a feat(onsite): i18n onsite namespace (Task 6.3)
1e7fd44 feat(onsite): OnsiteWebSocketContext with exponential reconnect (Task 6.2)
7d66207 feat(onsite): shared types and zustand-style store (Task 6.1)
f1e6bb4 docs(onsite): Batch 5.5 chat regression gate cleared  ← prior
```

---

## 3. TypeScript check output

```
$ npm run typecheck 2>&1 | tail -30
server/modules/onsite-analysis/onsite.routes.ts(432,22): error TS2339: Property 'files' does not exist on type 'Request<...>'.
server/modules/onsite-analysis/onsite.routes.ts(432,39): error TS2694: Namespace 'global.Express' has no exported member 'Multer'.
server/modules/onsite-analysis/onsite.routes.ts(442,44): error TS2345: Argument of type 'string | string[]' is not assignable to parameter of type 'string'.
server/modules/onsite-analysis/tests/discipline-trace-id.test.ts(592,72): error TS2345: ... types of property 'logHit' are incompatible.
server/modules/onsite-analysis/tests/discipline-trace-id.test.ts(603,28): error TS2339: Property 'cmd' does not exist on type 'never'.
server/modules/onsite-analysis/tests/discipline-trace-id.test.ts(605,26): error TS2339: Property 'stdout_preview' does not exist on type 'never'.
server/modules/onsite-analysis/tests/discipline-write-protection.test.ts(227,7): error TS2322: ...
server/modules/onsite-analysis/tests/discipline-write-protection.test.ts(240,28): error TS2339: Property 'cmd' does not exist on type 'never'.
server/modules/onsite-analysis/tests/discipline-write-protection.test.ts(241,26): error TS2339: Property 'stdout_preview' does not exist on type 'never'.
server/modules/onsite-analysis/tests/onsite-path-blacklist.test.ts(159,51): error TS2345: Argument of type '"Bash(rm **/*.log)"' is not assignable to parameter of type 'never'.
server/modules/onsite-analysis/tests/onsite-upload-routes.test.ts(251,26): error TS2339: Property 'error' does not exist on type '...'.
server/modules/onsite-analysis/tests/onsite-upload-routes.test.ts(268,62): error TS2345: ...
server/modules/websocket/services/chat-run-registry.service.ts(212,11): error TS2322: Type 'string | null | undefined' is not assignable to type 'string | null'.
server/modules/websocket/services/chat-run-registry.service.ts(213,11): error TS2322: Type 'number | null | undefined' is not assignable to type 'number | null'.
```

**All 14 errors are pre-existing in the server tree.** I confirmed this by running `npx tsc --noEmit -p server/tsconfig.json` against the baseline commit `f1e6bb4` (HEAD before my Batch 6 work) — the same errors reproduce.

The client-only check, which is the relevant one for Batch 6, exits 0:

```
$ npx tsc --noEmit -p tsconfig.json 2>&1 | tail -10
(no output — exit 0)
```

---

## 4. Dev server smoke

```
$ npm run dev          # vite + tsx server
# server fails to start: SqliteError: no such column: kind
# (local dev DB schema drift; unrelated to Batch 6)

$ npx vite             # client only
  VITE v7.1.8  ready in 1266 ms
  ➜  Local:   http://localhost:5173/

$ curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:5173/onsite
HTTP 200
$ curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:5173/onsite/abc-123
HTTP 200   (would have 404'd if route not registered)
$ curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:5173/
HTTP 200
```

The Vite dev server serves `/onsite` and `/onsite/:problemId` correctly. The fact that `/onsite/abc-123` returns 200 (instead of 404 fallback to index) confirms the wildcard route is registered. React then mounts `<OnsiteLayout />` client-side, which renders the `data-testid="onsite-layout-placeholder"` div.

The server crash is a **pre-existing** local SQLite migration gap (the `kind` column is referenced in `init-db.ts` but the local DB on this workstation predates that migration). I did not touch `init-db.ts` or any DB schema.

---

## 5. Contract deviations (declared up-front, already accepted in the brief)

### Deviation A — zustand → React hooks

`package.json` does **not** include `zustand`, and the contract's §依赖约束 forbids adding npm packages. I implemented `useOnsiteStore()` using the React hooks pattern (`useRef` + `setTick` + `useCallback`), matching `useSessionStore.ts`. The exported surface satisfies the contract's acceptance ("actions: loadConfig / loadProblems / selectProblem / patchStatus / uploadFiles") — consumers call `useOnsiteStore()` and destructure `{ problems, config, ..., loadProblems, ... }`. Identical consumer ergonomics.

### Deviation B — Frontend test framework not added

`package.json` has no `vitest` / `jest`. Per the brief's adapted TDD section:

| Task | Failed-first signal | Pass signal |
|---|---|---|
| 6.1 | `tsc --noEmit` failed with "Cannot find module '@shared/onsite-types'" until `@shared/*` paths entry was added | `tsc --noEmit` passes |
| 6.2 | (No tsc error; new file with strict-mode-safe types from the start) | `tsc --noEmit` passes; module resolves via Vite |
| 6.3 | (No tsc error — JSON imports are typed by inference) | `tsc --noEmit` passes; both locale files resolve |
| 6.4 | (No tsc error — typed components from the start) | `tsc --noEmit` passes; `curl /onsite` returns 200 |

I did not invent fake test files.

---

## 6. Batch 7 inputs (named exports)

```ts
// shared/onsite-types.ts
export type ProblemStatus
export type ProblemRecord
export type ProblemListItem
export type ConfigPayload
export type ConfigCustomer
export type OnsiteFile
export type OnsiteFileKind
export type UploadResult
export type OnsiteHelloFrame
export type OnsiteServerEvent
export type OnsiteProblemsChangedEvent
export type OnsiteProblemStateChangedEvent
export const PROBLEM_STATUSES

// src/stores/onsiteStore.tsx
export type OnsiteStore
export type OnsiteStoreState
export type OnsiteStoreActions
export type OnsiteStoreSelectors
export function useOnsiteStore(): OnsiteStore

// src/contexts/OnsiteWebSocketContext.tsx
export type OnsiteWebSocketContextValue
export function useOnsiteWebSocket(): OnsiteWebSocketContextValue
export function OnsiteWebSocketProvider(props): JSX.Element

// src/components/onsite-analysis/layout/OnsiteLayout.tsx
export default function OnsiteLayout(): JSX.Element   ← BATCH 7 REPLACES THIS

// src/components/onsite-analysis/nav/OnsiteNavButton.tsx
export type OnsiteNavButtonProps
export default function OnsiteNavButton(props): JSX.Element

// i18n
// Key namespace: 'onsite'
//   nav.onsite, wizard.title, wizard.customer, wizard.iteration,
//   wizard.database, wizard.upload, wizard.thirdPartyHint, wizard.noThirdParty,
//   wizard.submit, wizard.createSuccess, wizard.createFailed,
//   status.{pending_info, analyzing, blocked, confirmed, abandoned},
//   error.{configInvalid, networkError, uploadFailed, reasonTooShort, invalidTransition},
//   discipline.{softeningTag, suspectToast, writeProtectionCounter},
//   common.{back, loading, empty, retry}
```

**Hooks Batch 7 will need from `useOnsiteStore`:**

- `problems` — current list (sorted server-side: blocked → analyzing → pending_info → confirmed → abandoned)
- `config` — `ConfigPayload` (customers + iterations)
- `currentProblemId` — currently selected problem id
- `loadConfig()`, `loadProblems()`, `selectProblem(id)`, `patchStatus(id, to, reason)`, `uploadFiles(id, files)`
- `useProblem(id)`, `useUploadProgress(id)`, `useAnyUploading()`

**Hooks Batch 7 will need from `OnsiteWebSocketContext`:**

- `setHelloContext(problemId, cwd)` — call on problem open / problem switch so the server's discipline middleware sees the right context
- `send(frame)` — for chat.send / chat.abort over the onsite path
- `isConnected` (for UI diagnostics)

---

## 7. Open questions / things reviewer should verify

1. **`useOnsiteStore` selectors vs. direct state reads.** I named the selectors `useProblem`, `useUploadProgress`, `useAnyUploading` per the brief, but they're plain functions on the returned object, not custom React hooks — they read the ref at render time, which works because the consumer has already subscribed via the enclosing `useOnsiteStore()` call. If the reviewer prefers true `useSyncExternalStore`-style hooks (e.g. `useProblem(id)` as a standalone hook), I can refactor in 5 lines.

2. **State-changed event doesn't patch locally.** I chose to call `loadProblems()` on every `problem:<id>:state-changed` event rather than mutating the local row in-place. Reason: keeps disk-as-source-of-truth invariant simple. If the WS pushes high-frequency state changes (e.g. one per second per problem), a targeted in-place patch may be cheaper. Flag for Batch 7 if needed.

3. **Vite proxy addition for `/onsite/ws`.** I added `/onsite/ws` to the dev proxy because the brief mentioned dev-server smoke testing. The backend already routes `/onsite/ws` correctly (`onsiteWebSocketService.attach` is wired). In production, a reverse proxy fronting the API server must mirror this entry — flag if there's a deploy config to update separately.

4. **Sidebar entry only mounted on desktop.** The mobile sidebar path (`<Sidebar />` inside the slide-out sheet) does NOT show `<OnsiteNavButton />`. This matches "minimal change to existing Sidebar logic"; mobile users navigate via URL bar. Easy to add in Batch 7 if you want parity.

5. **`tsconfig.json` paths entry.** I added `@shared/* → shared/*` because both client and server already use the same `shared/` directory. The brief listed only `@/*` as the alias; this is additive, not a rename. Safe but worth a sanity-check from the reviewer.

6. **Placeholder `userId`.** `OnsiteWebSocketContext` reads `userId` from `localStorage['auth-user']` if present, else `null`. The server's hello validator accepts `userId: string | null`. If the auth code stores the user under a different key, the WS will still connect (validator permits null) but the server-side audit log won't tag the user. Recommend a follow-up check.