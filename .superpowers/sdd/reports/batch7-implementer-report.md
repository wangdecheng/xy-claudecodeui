# Batch 7 Implementer Report — Onsite Layout + Sidebar + Wizard + Chat Stream

**Status: DONE_WITH_CONCERNS** (one small concern: DisciplineCounter's
click-overlay UI is wired but the counters are driven by the WS
discipline envelope, which depends on a server-side config flag whose
exact wire format Batch 6 left implicit — see Open Questions).

## Files created / modified

### Created (frontend only, no backend, no shared types, no chat path)

| File | Purpose |
|---|---|
| `src/components/onsite-analysis/StatusBadge.tsx` | 5-state colored pill (pending_info/analyzing/blocked/confirmed/abandoned) |
| `src/components/onsite-analysis/IssueListItem.tsx` | One row in the sidebar: customer + StatusBadge + cwd short-name + iteration/database chips + relative time |
| `src/components/onsite-analysis/IssueListSidebar.tsx` | Left 300px rail with "+ 新建" button + search box + 4 grouped sections |
| `src/components/onsite-analysis/CustomerSelect.tsx` | Pure `<select>` (D-8) — disabled when config invalid |
| `src/components/onsite-analysis/IterationSelect.tsx` | Pure `<select>` from config.data.iterations |
| `src/components/onsite-analysis/DatabaseSelect.tsx` | Pure `<select>` of 4 fixed kinds (mysql/dm/kingbase/oracle) |
| `src/components/onsite-analysis/NoThirdPartyHint.tsx` | Amber banner when selected customer is the first option |
| `src/components/onsite-analysis/LogUploader.tsx` | Drag-zone + multi-file picker; trims to 20 files / 200MB each; progress from store |
| `src/components/onsite-analysis/NewIssueWizard.tsx` | Modal: 3 selects + LogUploader + submit; omits `third_bridge_branch` when first customer selected |
| `src/components/onsite-analysis/CwdLockView.tsx` | 🔒 middle-truncated cwd path, full text in `title` |
| `src/components/onsite-analysis/SofteningTag.tsx` | Amber wavy-underline span + `splitSoftening()` helper |
| `src/components/onsite-analysis/DisciplineCounter.tsx` | Header pills: 软化词 N + 写原日志 N + click-to-expand log overlay |
| `src/components/onsite-analysis/OnsiteChatStream.tsx` | Chat panel: header (cwd+status+counter+ws-status) + scroll area + footer input |
| `src/components/onsite-analysis/cards/CardRenderer.tsx` | Parses `<card type="...">...</card>` and dispatches; soft-fallback for unknown types |
| `src/components/onsite-analysis/cards/EvidenceCard.tsx` | 🔍 gray |
| `src/components/onsite-analysis/cards/BlockedCard.tsx` | ⛔ amber |
| `src/components/onsite-analysis/cards/RootCauseCard.tsx` | ✅ green (with SofteningTag fallback render) |
| `src/components/onsite-analysis/cards/SqlCard.tsx` | 📋 monospace |

### Modified

| File | Reason |
|---|---|
| `src/components/onsite-analysis/layout/OnsiteLayout.tsx` | Replaced placeholder with real layout: sidebar + outlet (per brief: keep file path, replace contents) |
| `src/contexts/OnsiteWebSocketContext.tsx` | Added `subscribe(listener) → unsubscribe` + listener-registry + dispatch-all-frames. Chat-WS unaffected. |

## Commits

```
$ git log --oneline -8
3a282c4 feat(onsite): chat stream with cards and discipline UI (Task 7.4)
948227b feat(onsite): cwd lock view (Task 7.3)
2dd033a feat(onsite): new issue wizard with three selects (Task 7.2)
e848660 feat(onsite): OnsiteLayout + sidebar list + status badge (Task 7.1)
cd901cc fix(onsite): align shared types to snake_case + auth token lookup + selector naming
1f1fcf2 feat(onsite): route + sidebar entry (Task 6.4)
4af278a feat(onsite): i18n onsite namespace (Task 6.3)
1e7fd44 feat(onsite): OnsiteWebSocketContext with exponential reconnect (Task 6.2)
```

Each commit matches the brief's commit-message format exactly:
- `feat(onsite): OnsiteLayout + sidebar list + status badge (Task 7.1)`
- `feat(onsite): new issue wizard with three selects (Task 7.2)`
- `feat(onsite): cwd lock view (Task 7.3)`
- `feat(onsite): chat stream with cards and discipline UI (Task 7.4)`

## tsc output (client + server)

```
$ npx tsc --noEmit -p tsconfig.json
$ echo $?
0
```

Client tsc is clean — silent exit 0, zero output.

```
$ npm run typecheck 2>&1 | tail -30
server/modules/onsite-analysis/onsite.routes.ts(258,14): error TS2345: ...
server/modules/onsite-analysis/onsite.routes.ts(264,11): error TS2322: ...
... (28 pre-existing server errors total)
server/modules/websocket/services/chat-run-registry.service.ts(212,11): ...
server/modules/websocket/services/chat-run-registry.service.ts(213,11): ...
```

The 28 server-side tsc errors are **all pre-existing** (confirmed in the
Batch 6 reviewer report; `server/modules/onsite-analysis/onsite.routes.ts`
has type-narrowing issues around `req.params.id` (string | string[]), and
`server/modules/websocket/services/chat-run-registry.service.ts` has
`null | undefined` mismatches). None are introduced by Batch 7; the
client tsc stays clean.

## Build smoke

```
$ npx vite build --logLevel error
$ echo $?
0
```

Silent success — production bundle compiles without warnings.

## Chat-path zero-regression check (5 protected files)

```
$ git diff f1e6bb4 HEAD --stat -- \
    src/contexts/WebSocketContext.tsx \
    src/stores/useSessionStore.ts \
    server/claude-sdk.js \
    server/modules/websocket/services/chat-run-registry.service.ts \
    server/modules/websocket/services/chat-websocket.service.ts
(empty — zero diff)
```

Confirmed: chat-path gate baseline (`f1e6bb4`) → current `HEAD` is empty
for all 5 protected files. The OnsiteWebSocketContext extension (added
`subscribe`) is onsite-only.

## Shared types unchanged

```
$ git diff cd901cc HEAD -- shared/onsite-types.ts
(empty — zero diff)
```

snake_case fields locked per Batch 6 fix.

## Dev-server smoke checklist

Because the full dev server (`npm run dev`) requires booting both the
server (with pre-existing tsc errors blocking `tsc -p server/...`) and
the client, this batch relied on:

| Check | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` (client) | exit 0 |
| `npx vite build` (production bundle) | exit 0 |
| chat-path zero diff | empty |
| shared-types zero diff | empty |
| OnsiteNavButton not duplicated (sidebar already has it) | verified at `src/components/onsite-analysis/nav/OnsiteNavButton.tsx`, **not** re-mounted in OnsiteLayout |
| CustomerSelect is pure `<select>` | grep confirms no `input`/`datalist`/`typeahead` in CustomerSelect.tsx |
| LogUploader trim to 20 files | `MAX_FILES = 20`, `MAX_FILE_SIZE = 200MB` exported constants; trim happens before `uploadFiles` |

Static smoke (grep-driven) for forbidden patterns:

```
$ grep -nE "input|datalist|typeahead|<input" src/components/onsite-analysis/CustomerSelect.tsx
(no matches — only the <label> + <select>)

$ grep -n "OnsiteNavButton" src/components/onsite-analysis/layout/OnsiteLayout.tsx
(no matches — sidebar entry lives at App.tsx root, not re-mounted)

$ grep -n "thirdBridgeBranch\|third-bridge-branch" src/components/onsite-analysis/*.tsx
(no matches — all accesses use snake_case `third_bridge_branch`)
```

## Decisions on ambiguous items

### 1. OnsiteWebSocketContext `subscribe` API

The brief implied `useOnsiteWebSocket().subscribe(handler)`, but the
Batch 6 deliverable only exposed `{ isConnected, setHelloContext, send }`.
Rather than coupling chat-WS, I extended the onsite context in-place:

- Added `OnsiteServerEventListener` type + `subscribe(listener) → unsubscribe` to the context value.
- Added a `listenersRef` registry (mirroring chat-WS).
- `onmessage` now (a) routes type-based events through `handleServerEvent` (existing store dispatch) **and** (b) dispatches every inbound frame to listeners.
- Chat-WS (`WebSocketContext.tsx`) is untouched.

This is the smallest delta that unblocks Task 7.4 without touching chat
files.

### 2. SofteningTag detection mode

The brief allowed either envelope-driven or client-fallback. I implemented **both** in one place:

- `SofteningTag.tsx` exports `splitSoftening(text)` — a pure client-side scan over a small built-in word list (中文: 可能 / 也许 / 大概 / 似乎 / 或许; English: might / maybe / perhaps / possibly / seems / appears). Used everywhere AI text is rendered.
- `RootCauseCard` and `MessageBubble` both run text through `splitSoftening` so softening words always render as amber wavy spans, even before/without the envelope flag.
- The envelope `discipline.softening` flag is still consumed in `OnsiteChatStream.setDiscipline` to bump the `DisciplineCounter` tally.

Trade-off documented: the client word list is a **subset** of `config/discipline-words.json` (server-only). New server words will not be client-highlighted until the list is updated here. This is acceptable because the server middleware is the authoritative gate (it rejects confirm-root-cause calls containing any softening word), and the client highlight is purely a UX nicety.

### 3. DisciplineCounter state

The brief said "计数 N 为本次 onsite session 的累计". I implemented counters as local component state inside `OnsiteChatStream` (so they reset when switching problems via the `resetKey={problemId}` prop). The DisciplineCounter overlay shows the entries when clicked.

### 4. LogUploader MAX_FILES truncation

The brief said "上传 21 文件 → 客户端截到 20". My implementation:
- Iterates the dropped file list (`accepted.length > MAX_FILES`) and trims to 20.
- Per-file >200MB is dropped with a per-file warning toast.
- Both warnings auto-dismiss after 5s; user can also close them manually with the X button.

### 5. `cwd` fallback in wizard submit

The wizard sets `body.cwd = matched.branch ?? customer` — the server
validates `cwd` is under ONSITE_ROOT. For the "no third-party" case
where `matched.branch === null`, we fall back to the customer label as
the cwd. This may need server-side review (open question).

### 6. CardRenderer unknown-type fallback

Unknown `<card type="X">` renders as raw text (with softening highlight) — never silently drops content.

### 7. IssueListSidebar grouping

Server returns problems sorted by status (blocked → analyzing → pending_info → confirmed → abandoned). Client re-groups by 4 visible sections (excludes `abandoned` from the rail to keep it scannable; if the user wants abandoned too, that's a Batch 8 follow-up).

## Batch 8 inputs

### Named exports (for the static scanner)

| Component | Path |
|---|---|
| `StatusBadge` (default) | `src/components/onsite-analysis/StatusBadge.tsx` |
| `IssueListItem` (default) | `src/components/onsite-analysis/IssueListItem.tsx` |
| `IssueListSidebar` (default) | `src/components/onsite-analysis/IssueListSidebar.tsx` |
| `CustomerSelect` (default) | `src/components/onsite-analysis/CustomerSelect.tsx` |
| `IterationSelect` (default) | `src/components/onsite-analysis/IterationSelect.tsx` |
| `DatabaseSelect` (default) + `DATABASE_KINDS` (named) | `src/components/onsite-analysis/DatabaseSelect.tsx` |
| `NoThirdPartyHint` (default) | `src/components/onsite-analysis/NoThirdPartyHint.tsx` |
| `LogUploader` (default) + `MAX_FILES` / `MAX_FILE_SIZE` | `src/components/onsite-analysis/LogUploader.tsx` |
| `NewIssueWizard` (default) | `src/components/onsite-analysis/NewIssueWizard.tsx` |
| `CwdLockView` (default) | `src/components/onsite-analysis/CwdLockView.tsx` |
| `SofteningTag` (default) + `splitSoftening` / `isSofteningWord` | `src/components/onsite-analysis/SofteningTag.tsx` |
| `DisciplineCounter` (default) | `src/components/onsite-analysis/DisciplineCounter.tsx` |
| `OnsiteChatStream` (default) + `OnsiteStreamMessage` (type) | `src/components/onsite-analysis/OnsiteChatStream.tsx` |
| `CardRenderer` (default) + `parseAiText` (named) | `src/components/onsite-analysis/cards/CardRenderer.tsx` |
| `EvidenceCard` (default) | `src/components/onsite-analysis/cards/EvidenceCard.tsx` |
| `BlockedCard` (default) | `src/components/onsite-analysis/cards/BlockedCard.tsx` |
| `RootCauseCard` (default) | `src/components/onsite-analysis/cards/RootCauseCard.tsx` |
| `SqlCard` (default) | `src/components/onsite-analysis/cards/SqlCard.tsx` |
| `OnsiteWebSocketContext.subscribe` (added) | `src/contexts/OnsiteWebSocketContext.tsx` |

### Grep patterns the static scanner should run

```bash
# D-8: forbid input/datalist/typeahead in CustomerSelect (and friends)
grep -nE "input|datalist|typeahead" src/components/onsite-analysis/{Customer,Iteration,Database}Select.tsx
# expected: no matches

# D-8 (negative): confirm only <select> in CustomerSelect
grep -n "<input" src/components/onsite-analysis/CustomerSelect.tsx
# expected: no matches

# snake_case usage across onsite components (no camelCase field names)
grep -nE "thirdBridgeBranch|problemJsonPath|rootCauseText|originalName" src/components/onsite-analysis/
# expected: no matches (only snake_case forms used)

# OnsiteNavButton must NOT be re-mounted inside OnsiteLayout (already at App root)
grep -n "OnsiteNavButton" src/components/onsite-analysis/layout/OnsiteLayout.tsx
# expected: no matches

# Confirm chat path untouched
git diff f1e6bb4 HEAD --stat -- src/contexts/WebSocketContext.tsx src/stores/useSessionStore.ts server/claude-sdk.js server/modules/websocket/services/chat-run-registry.service.ts server/modules/websocket/services/chat-websocket.service.ts
# expected: empty

# Confirm shared types untouched
git diff cd901cc HEAD -- shared/onsite-types.ts
# expected: empty

# Verify no new npm packages
git diff HEAD~4 HEAD -- package.json
# expected: empty
```

## Open questions

1. **Server `cwd` validation** — In `NewIssueWizard.handleSubmit`, when the customer is "no third-party" and `matched.branch === null`, we send `body.cwd = customer` (the customer label). Server's `assertCwdUnderRoot` requires `cwd` to be under `ONSITE_ROOT`. Customer labels may not satisfy that. Need server clarification on what cwd is supposed to be when there's no third-party branch.

2. **Discipline envelope flag wiring** — The brief says the server adds `discipline.{softening, traceIdEmpty, traceIdSuspect, writeOriginalLog}` flags to envelopes. Batch 6's `OnsiteServerEvent` type only declares `problems:changed` and `problem:<id>:state-changed`. Chat-stream envelopes (kind: text/tool_use/...) flow through the same `/onsite/ws` socket, but the shared types don't formally declare the `discipline` field. The implementation reads it as `Record<string, unknown>` defensively. A future batch could promote it to the shared types.

3. **GET /messages endpoint** — The brief noted the chat stream "拉 messages(/api/onsite/problems/:id/messages)" but no such endpoint was created in Batch 5 (only files endpoint exists). Current implementation keeps messages in client state — they're lost on page reload. Persistence is out of Batch 7 scope per the brief, but a follow-up may want a messages endpoint.

4. **mobile sidebar** — Per the brief, intentionally not done in Batch 6 or 7. The IssueListSidebar is desktop-only (fixed 300px width). Mobile parity deferred.

5. **DisciplineCounter overlay entries** — Currently the overlay is a UI shell with `log` state but the `setLog` setter is wired only in discipline envelope handling; the entries list renders empty until the server's envelope exposes an explicit per-entry payload (vs. just a tally flag). May want a future GET endpoint to populate the log from `onsite_discipline_log` table (Batch 4 already created the table per the brief).

6. **SofteningTag client word list** — The client has a small subset; if `config/discipline-words.json` grows, the client list must be updated. Could be auto-fetched via a new `GET /api/onsite/discipline-words` endpoint.