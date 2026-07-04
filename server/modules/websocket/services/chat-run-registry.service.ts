import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { onsiteProblemsDb } from '@/modules/database/repositories/onsite-problems.db.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import { disciplineSofteningMiddleware } from '@/modules/onsite-analysis/discipline/discipline-softening.middleware.js';
import { disciplineTraceIdMiddleware } from '@/modules/onsite-analysis/discipline/discipline-trace-id.middleware.js';
import { disciplineWriteProtectionMiddleware } from '@/modules/onsite-analysis/discipline/discipline-write-protection.middleware.js';
import { onsiteDisciplineLogDb } from '@/modules/database/repositories/onsite-discipline-log.db.js';
import { apply as applyState } from '@/modules/onsite-analysis/state-machine.service.js';
import type {
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';

type ChatRunStatus = 'running' | 'completed';

/**
 * One live (or recently finished) provider run for a single app session.
 *
 * State notes — why each mutable field is essential:
 * - `providerSessionId`: the provider-native id captured mid-run. The abort
 *   handler needs it to address the provider runtime, and the DB mapping is
 *   written from it so history/resume work after the run.
 * - `status`: drives `chat_subscribed.isProcessing`, prevents double sends
 *   into the same session, and guards the synthetic-complete fallback in the
 *   chat handler (only emitted when a runtime died without completing).
 * - `lastSeq` / `events`: the per-run event log. Every live event gets a
 *   monotonically increasing `seq` and is buffered so a reconnecting client
 *   can replay exactly the events it missed via `chat.subscribe`.
 */
type ChatRunKind = 'chat' | 'onsite';

type ChatRun = {
  appSessionId: string;
  provider: LLMProvider;
  providerSessionId: string | null;
  status: ChatRunStatus;
  lastSeq: number;
  events: NormalizedMessage[];
  writer: ChatSessionWriter;
  startedAt: number;
  completedAt: number | null;
  /**
   * Routing tag for discipline middleware attachment:
   *  - 'chat'   → 默认;chat 路径,中间件不挂
   *  - 'onsite' → onsite 路径,discipline 中间件链会读取 ws.kind 决定是否挂
   * Batch 4 起新增;不改 chat 调用处行为(不传则默认 'chat')。
   */
  kind: ChatRunKind;
};

/**
 * How long a completed run stays available for replay. Covers the window
 * between a run finishing and the client refreshing history over REST (for
 * example when the browser tab was asleep while the run completed).
 */
const COMPLETED_RUN_RETENTION_MS = 5 * 60 * 1000;

/**
 * Upper bound on buffered events per run so a very long tool-heavy run cannot
 * grow memory unbounded. When exceeded, the oldest events are dropped —
 * a reconnecting client whose `lastSeq` predates the buffer falls back to a
 * REST history refresh, which is always the authoritative source.
 */
const MAX_BUFFERED_EVENTS_PER_RUN = 5000;

/**
 * Active and recently-completed runs keyed by app session id.
 *
 * This map is the single in-memory source of truth for "is something running
 * for this session" — the chat websocket handler, abort path, and subscribe
 * path all consult it instead of asking each provider runtime individually.
 */
const runs = new Map<string, ChatRun>();

async function broadcastCanonicalSessionUpsert(appSessionId: string): Promise<void> {
  const row = sessionsDb.getSessionById(appSessionId);
  if (!row || row.isArchived) {
    return;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  const payload = JSON.stringify({
    kind: 'session_upserted',
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id,
    provider: row.provider,
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
      }
      : null,
    timestamp: new Date().toISOString(),
  });

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  });
}

/**
 * Loads the `.traceId` file from the run's cwd (used by the trace-id
 * middleware to know which trace id to scan for in tool_result envelopes).
 * Returns null if the file is missing or unreadable.
 */
function loadTraceIdFromCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  try {
    // Lazy require — this code path is only hit on the onsite run, which
    // is a minority case; we don't want to drag in fs into every chat run.
    const fs = require('node:fs') as typeof import('node:fs');
    const raw = fs.readFileSync(`${cwd}/.traceId`, 'utf8');
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Attaches the three discipline middlewares to the run's outbound connection.
 *
 * Only invoked when run.kind === 'onsite'. The middleware `enabledFor` check
 * uses chatRunRegistry.getRunKind so even if a connection is reused for a
 * later chat run, the middlewares remain inert.
 *
 * Idempotent: each middleware early-returns on a second attachToWs for the
 * same ws because the middleware swaps ws.send; the second call wraps the
 * already-wrapped send and discards the inner wrap. We guard with a flag on
 * the connection to avoid double-wrap stacking.
 */
function attachOnsiteDisciplineMiddlewares(run: ChatRun): void {
  const ws = run.writer.ws as RealtimeClientConnection & {
    __onsiteDisciplineAttached?: boolean;
    kind?: string;
  };

  if (ws.__onsiteDisciplineAttached) {
    return;
  }
  ws.__onsiteDisciplineAttached = true;
  // Mark ws.kind so the middlewares' enabledFor(ws) (when bound to a fixed
  // enabledFor closure) can short-circuit. The actual enabledFor closures
  // we pass here consult chatRunRegistry, but tagging the ws also keeps
  // other code paths (e.g. logging) happy.
  ws.kind = 'onsite';

  const problemId = run.appSessionId;
  const cwd = (() => {
    const row = onsiteProblemsDb.findById(run.appSessionId);
    return row?.cwd ?? null;
  })();

  const enabledFor = (): boolean => chatRunRegistry.getRunKind(run.appSessionId) === 'onsite';

  disciplineSofteningMiddleware.attachToWs(ws as never, {
    enabledFor: enabledFor as never,
    logHit: (entry) => {
      try {
        onsiteDisciplineLogDb.append({
          problem_id: entry.problemId,
          message_id: entry.messageId ?? null,
          kind: entry.kind,
          word: entry.word,
          position: entry.position,
          cmd: null,
          stdout_preview: null,
        });
      } catch {
        /* discipline log failures must not block sends */
      }
    },
  });

  disciplineTraceIdMiddleware.attachToWs(ws as never, {
    enabledFor: enabledFor as never,
    getTraceId: () => loadTraceIdFromCwd(cwd) ?? process.env.TRACE_ID ?? null,
    applyBlocked: async (id: string, reason: string): Promise<void> => {
      try {
        await applyState(id, 'blocked', reason, null);
      } catch {
        /* state-machine rejection or unknown id — ignore */
      }
    },
    logHit: (entry) => {
      try {
        onsiteDisciplineLogDb.append({
          problem_id: entry.problemId,
          message_id: entry.messageId ?? null,
          kind: entry.kind,
          word: entry.word,
          position: entry.position,
          cmd: entry.cmd ?? null,
          stdout_preview: entry.stdout_preview ?? null,
        });
      } catch {
        /* ignore */
      }
    },
  });

  disciplineWriteProtectionMiddleware.attachToWs(ws as never, {
    enabledFor: enabledFor as never,
    logHit: (entry) => {
      try {
        onsiteDisciplineLogDb.append({
          problem_id: entry.problemId,
          message_id: entry.messageId ?? null,
          kind: entry.kind,
          word: null,
          position: null,
          cmd: entry.cmd,
          stdout_preview: entry.stdout_preview,
        });
      } catch {
        /* ignore */
      }
    },
  });
}

function evictRunLater(appSessionId: string): void {
  const timer = setTimeout(() => {
    const run = runs.get(appSessionId);
    if (run && run.status === 'completed') {
      runs.delete(appSessionId);
    }
  }, COMPLETED_RUN_RETENTION_MS);

  // Never keep the process alive just to evict a buffered run.
  timer.unref?.();
}

/**
 * Decorates one outbound live event for a run and records it in the event log.
 *
 * Responsibilities:
 * 1. Remap `sessionId` (and `actualSessionId` on `complete`) to the stable
 *    app session id — provider-native ids never leave the backend.
 * 2. Assign the next `seq` so clients can detect/replay gaps.
 * 3. Buffer the event for `chat.subscribe` replay.
 * 4. Flip the run to `completed` when the terminal `complete` event passes by.
 */
function decorateAndRecordEvent(run: ChatRun, message: NormalizedMessage): NormalizedMessage | null {
  // Exactly-one-complete contract: when a run is aborted the chat handler
  // emits the terminal `complete` immediately, but the killed runtime may
  // still emit its own `complete` from its exit handler moments later.
  // Whichever arrives first wins; the duplicate is dropped here.
  if (message.kind === 'complete' && run.status === 'completed') {
    return null;
  }

  run.lastSeq += 1;

  const outbound: NormalizedMessage = {
    ...message,
    sessionId: run.appSessionId,
    seq: run.lastSeq,
  };

  if (message.kind === 'complete') {
    // The provider may report its own id here; the frontend only ever knows
    // the app id, so the "actual" id is by definition the app id as well.
    outbound.actualSessionId = run.appSessionId;
    run.status = 'completed';
    run.completedAt = Date.now();
    evictRunLater(run.appSessionId);
  }

  run.events.push(outbound);
  if (run.events.length > MAX_BUFFERED_EVENTS_PER_RUN) {
    run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS_PER_RUN);
  }

  return outbound;
}

/**
 * Records the provider-native session id for a run and persists the
 * app-id-to-provider-id mapping so history fetches and future resumes can
 * address the provider transcript.
 *
 * Called from the gateway writer when the runtime either calls
 * `setSessionId(...)` or emits its `session_created` event — whichever
 * happens first wins; later calls with the same id are no-ops.
 */
function recordProviderSessionId(run: ChatRun, providerSessionId: string): void {
  if (!providerSessionId || run.providerSessionId === providerSessionId) {
    return;
  }

  run.providerSessionId = providerSessionId;

  try {
    sessionsDb.assignProviderSessionId(run.appSessionId, providerSessionId);
    void broadcastCanonicalSessionUpsert(run.appSessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to broadcast canonical session mapping', {
        appSessionId: run.appSessionId,
        providerSessionId,
        error: message,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ChatRunRegistry] Failed to persist provider session id mapping', {
      appSessionId: run.appSessionId,
      providerSessionId,
      error: message,
    });
  }
}

/**
 * Registry of live provider runs keyed by the stable app session id.
 *
 * The registry is what makes the websocket protocol provider-independent:
 * every run gets a `ChatSessionWriter` that remaps provider-native session
 * ids to the app id, assigns `seq` numbers, and buffers events for replay —
 * regardless of which provider runtime produced them.
 */
export const chatRunRegistry = {
  /**
   * Starts tracking a run and returns it, or `null` when a run is already in
   * progress for the session (callers must reject the duplicate send).
   *
   * `kind` defaults to 'chat' so existing chat callers are unaffected.
   * Onsite websocket service passes `kind: 'onsite'` so discipline middlewares
   * (softening / traceId / write-protection) can be attached by ws.kind === 'onsite'.
   */
  startRun(input: {
    appSessionId: string;
    provider: LLMProvider;
    providerSessionId: string | null;
    connection: RealtimeClientConnection;
    userId: string | number | null;
    kind?: ChatRunKind;
  }): ChatRun | null {
    const existing = runs.get(input.appSessionId);
    if (existing && existing.status === 'running') {
      return null;
    }

    const kind: ChatRunKind = input.kind === 'onsite' ? 'onsite' : 'chat';

    const run: ChatRun = {
      appSessionId: input.appSessionId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      status: 'running',
      lastSeq: 0,
      events: [],
      writer: null as unknown as ChatSessionWriter,
      startedAt: Date.now(),
      completedAt: null,
      kind,
    };

    run.writer = new ChatSessionWriter({
      connection: input.connection,
      userId: input.userId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      onProviderSessionId: (providerSessionId) => {
        recordProviderSessionId(run, providerSessionId);
      },
      decorateOutboundEvent: (message) => decorateAndRecordEvent(run, message),
    });

    runs.set(input.appSessionId, run);

    // Onsite runs get the discipline middlewares attached to the writer's
    // outbound path so suspect/main signals see real tool_result envelopes
    // in production. Chat runs are unaffected.
    if (kind === 'onsite') {
      attachOnsiteDisciplineMiddlewares(run);
    }

    return run;
  },

  getRun(appSessionId: string): ChatRun | undefined {
    return runs.get(appSessionId);
  },

  /**
   * 返回某个 run 的 kind,用于 discipline 中间件决定是否挂载。
   * 未知 sessionId 返 undefined。
   */
  getRunKind(appSessionId: string): ChatRunKind | undefined {
    return runs.get(appSessionId)?.kind;
  },

  isProcessing(appSessionId: string): boolean {
    return runs.get(appSessionId)?.status === 'running';
  },

  listRunningRuns(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    return Array.from(runs.values())
      .filter((run) => run.status === 'running')
      .map((run) => ({
        sessionId: run.appSessionId,
        provider: run.provider,
        startedAt: run.startedAt,
        lastSeq: run.lastSeq,
      }));
  },

  /**
   * Re-attaches a run's outbound stream to a (new) websocket connection.
   *
   * This is the generic replacement for the Claude-only writer reconnect:
   * after a page refresh the new socket subscribes and immediately starts
   * receiving the still-running stream, for every provider.
   */
  attachConnection(appSessionId: string, connection: RealtimeClientConnection): boolean {
    const run = runs.get(appSessionId);
    if (!run) {
      return false;
    }

    run.writer.updateWebSocket(connection);

    // After re-attaching the new socket, the previously-wrapped ws.send is
    // gone (the old ws is no longer referenced by the writer). For onsite
    // runs we re-attach the middlewares on the new socket so discipline
    // signals continue to fire after a reconnect.
    if (run.kind === 'onsite') {
      // Reset the idempotency flag on the new connection (it's a fresh
      // object so it shouldn't have one, but be defensive).
      (connection as RealtimeClientConnection & { __onsiteDisciplineAttached?: boolean })
        .__onsiteDisciplineAttached = false;
      attachOnsiteDisciplineMiddlewares(run);
    }

    return true;
  },

  /**
   * Returns buffered events with `seq` greater than `afterSeq` for replay.
   *
   * An empty array with `run.lastSeq > afterSeq` not covered by the buffer
   * means the buffer was truncated; the client should refresh over REST.
   */
  replayEvents(appSessionId: string, afterSeq: number): NormalizedMessage[] {
    const run = runs.get(appSessionId);
    if (!run) {
      return [];
    }

    return run.events.filter((event) => typeof event.seq === 'number' && event.seq > afterSeq);
  },

  /**
   * Emits a synthetic terminal `complete` if (and only if) the run is still
   * marked running. Used when a provider runtime throws or resolves without
   * having produced its own terminal event, and by the abort path.
   */
  completeRun(appSessionId: string, opts: { exitCode: number; aborted?: boolean }): void {
    const run = runs.get(appSessionId);
    if (!run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Test-only escape hatch: clears every tracked run.
   */
  clearAll(): void {
    runs.clear();
  },
};
