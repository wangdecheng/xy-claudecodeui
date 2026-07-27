import { createHash } from 'node:crypto';
import { rm as removePath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { onsiteProblemsDb, sessionsDb } from '@/modules/database/index.js';
import type {
  OnsiteProblemRecord,
} from '@/modules/database/repositories/onsite-problems.db.js';
import type {
  SessionRetentionRecord,
} from '@/modules/database/repositories/sessions.db.js';
import { messagesStore } from '@/modules/onsite-analysis/messages-store.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { normalizeProjectPath, sanitizeLeafDirectoryName } from '@/shared/utils.js';

export const RETENTION_DAYS = 7;
export const RETENTION_PERIOD_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const RETENTION_RUN_HOUR = 3;

type ProviderName = 'claude' | 'cursor' | 'codex' | 'gemini' | 'opencode' | string;

type RetentionPath = {
  path: string;
  root: string;
};

export type ContentRetentionResult = {
  cutoff: string;
  sessionsScanned: number;
  sessionsDeleted: number;
  problemsScanned: number;
  problemsDeleted: number;
  skipped: number;
  failed: number;
};

export type ContentRetentionRoots = {
  claudeHome: string;
  cursorProjects: string;
  cursorChats: string;
  codexSessions: string;
  geminiTmp: string;
  onsiteRoot: string;
};

type RetentionLogger = Pick<Console, 'info' | 'warn' | 'error'>;

export type ContentRetentionDependencies = {
  now?: Date;
  retentionPeriodMs?: number;
  sessions?: SessionRetentionRecord[];
  problems?: OnsiteProblemRecord[];
  roots?: Partial<ContentRetentionRoots>;
  isSessionActive?: (sessionId: string) => boolean;
  removePath?: (targetPath: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
  deleteSession?: (sessionId: string) => boolean;
  deleteProblem?: (problemId: string) => void;
  clearProblemMessages?: (problemId: string) => void;
  logger?: RetentionLogger;
};

const SQLITE_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const CLEANABLE_PROVIDERS = new Set(['claude', 'cursor', 'codex', 'gemini']);

function getDefaultRoots(): ContentRetentionRoots {
  const home = os.homedir();
  return {
    claudeHome: path.join(home, '.claude'),
    cursorProjects: path.join(home, '.cursor', 'projects'),
    cursorChats: path.join(home, '.cursor', 'chats'),
    codexSessions: path.join(home, '.codex', 'sessions'),
    geminiTmp: path.join(home, '.gemini', 'tmp'),
    onsiteRoot: process.env.ONSITE_ROOT ?? path.join(home, 'work', 'customer-onsite-analysis'),
  };
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value || typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const trimmed = value.trim();
  const normalized = SQLITE_UTC_TIMESTAMP_REGEX.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertPathWithinRoot(candidatePath: string, rootPath: string, label: string): void {
  if (!isPathWithinRoot(candidatePath, rootPath)) {
    throw new Error(`${label} is outside its managed root: ${candidatePath}`);
  }
}

function mergeRoots(overrides?: Partial<ContentRetentionRoots>): ContentRetentionRoots {
  return { ...getDefaultRoots(), ...overrides };
}

function addPath(paths: RetentionPath[], candidatePath: string | null | undefined, root: string): void {
  if (!candidatePath || !candidatePath.trim()) {
    return;
  }

  const normalized = path.resolve(candidatePath);
  if (!paths.some((entry) => entry.path === normalized)) {
    paths.push({ path: normalized, root });
  }
}

function getSessionArtifactPaths(
  session: SessionRetentionRecord,
  roots: ContentRetentionRoots,
): RetentionPath[] {
  const paths: RetentionPath[] = [];
  const provider = session.provider as ProviderName;

  // Claude Code artifacts are explicitly protected, including files outside
  // the normal JSONL path shape if a legacy row points at them.
  if (provider === 'claude' || provider === 'opencode') {
    return paths;
  }

  if (provider === 'cursor') {
    addPath(paths, session.jsonl_path, roots.cursorProjects);

    // Cursor stores message blobs in one per-session store.db directory in
    // addition to the JSONL index file. Remove only that exact session leaf.
    const providerSessionId = session.provider_session_id ?? session.session_id;
    if (session.project_path && providerSessionId) {
      try {
        const workspaceHash = createHash('md5')
          .update(normalizeProjectPath(session.project_path))
          .digest('hex');
        const safeSessionId = sanitizeLeafDirectoryName(providerSessionId, 'Cursor session id');
        addPath(
          paths,
          path.join(roots.cursorChats, workspaceHash, safeSessionId),
          roots.cursorChats,
        );
      } catch {
        // The database index can still be cleaned, but an unsafe provider id
        // must not be turned into a filesystem path.
      }
    }
    return paths;
  }

  if (provider === 'codex') {
    addPath(paths, session.jsonl_path, roots.codexSessions);
    return paths;
  }

  if (provider === 'gemini') {
    addPath(paths, session.jsonl_path, roots.geminiTmp);
  }

  return paths;
}

function shouldSkipOnsiteProblem(
  problem: OnsiteProblemRecord,
  sessions: SessionRetentionRecord[],
  isSessionActive: (sessionId: string) => boolean,
): boolean {
  if (problem.status === 'analyzing') {
    return true;
  }

  return sessions.some(
    (session) =>
      session.cwd === problem.cwd && isSessionActive(session.session_id),
  );
}

async function removeManagedPath(
  entry: RetentionPath,
  remove: NonNullable<ContentRetentionDependencies['removePath']>,
  label: string,
): Promise<void> {
  assertPathWithinRoot(entry.path, entry.root, label);
  await remove(entry.path, { recursive: true, force: true });
}

async function deleteSessionContent(
  session: SessionRetentionRecord,
  roots: ContentRetentionRoots,
  remove: NonNullable<ContentRetentionDependencies['removePath']>,
  deleteSession: NonNullable<ContentRetentionDependencies['deleteSession']>,
): Promise<void> {
  const artifacts = getSessionArtifactPaths(session, roots);

  for (const artifact of artifacts) {
    await removeManagedPath(artifact, remove, `${session.provider} session artifact`);
  }

  if (!deleteSession(session.session_id)) {
    throw new Error(`Session index was not deleted: ${session.session_id}`);
  }
}

export async function cleanupExpiredContent(
  dependencies: ContentRetentionDependencies = {},
): Promise<ContentRetentionResult> {
  const now = dependencies.now ?? new Date();
  const retentionPeriodMs = dependencies.retentionPeriodMs ?? RETENTION_PERIOD_MS;
  const cutoffTimestamp = now.getTime() - retentionPeriodMs;
  const roots = mergeRoots(dependencies.roots);
  const logger = dependencies.logger ?? console;
  const sessions = dependencies.sessions ?? sessionsDb.getSessionsForRetention();
  const problems = dependencies.problems ?? onsiteProblemsDb.list();
  const isSessionActive = dependencies.isSessionActive ?? ((sessionId: string) => chatRunRegistry.isProcessing(sessionId));
  const remove = dependencies.removePath ?? removePath;
  const deleteSession = dependencies.deleteSession ?? ((sessionId: string) => sessionsDb.deleteSessionById(sessionId));
  const deleteProblem = dependencies.deleteProblem ?? ((problemId: string) => onsiteProblemsDb.deleteById(problemId));
  const clearProblemMessages = dependencies.clearProblemMessages ?? ((problemId: string) => messagesStore.clear(problemId));

  const result: ContentRetentionResult = {
    cutoff: new Date(cutoffTimestamp).toISOString(),
    sessionsScanned: sessions.length,
    sessionsDeleted: 0,
    problemsScanned: problems.length,
    problemsDeleted: 0,
    skipped: 0,
    failed: 0,
  };

  const analyzingProblemCwds = new Set(
    problems
      .filter((problem) => problem.status === 'analyzing')
      .map((problem) => problem.cwd),
  );

  for (const session of sessions) {
    const updatedAt = parseTimestamp(session.updated_at);
    if (updatedAt === null || updatedAt >= cutoffTimestamp) {
      result.skipped += 1;
      continue;
    }

    if (
      isSessionActive(session.session_id)
      || (session.cwd !== null && analyzingProblemCwds.has(session.cwd))
    ) {
      result.skipped += 1;
      continue;
    }

    if (!CLEANABLE_PROVIDERS.has(session.provider)) {
      // OpenCode is not used by this project and unknown providers must not be
      // mutated until their artifact ownership rules are explicitly defined.
      result.skipped += 1;
      continue;
    }

    try {
      await deleteSessionContent(session, roots, remove, deleteSession);
      result.sessionsDeleted += 1;
    } catch (error) {
      result.failed += 1;
      logger.error('[content-retention] session cleanup failed', {
        sessionId: session.session_id,
        provider: session.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const problem of problems) {
    const updatedAt = parseTimestamp(problem.updated_at);
    if (updatedAt === null || updatedAt >= cutoffTimestamp) {
      result.skipped += 1;
      continue;
    }

    if (shouldSkipOnsiteProblem(problem, sessions, isSessionActive)) {
      result.skipped += 1;
      continue;
    }

    try {
      const onsitePath = path.resolve(problem.cwd);
      assertPathWithinRoot(onsitePath, roots.onsiteRoot, 'Onsite problem directory');
      await remove(onsitePath, { recursive: true, force: true });
      deleteProblem(problem.id);
      clearProblemMessages(problem.id);
      result.problemsDeleted += 1;
    } catch (error) {
      result.failed += 1;
      logger.error('[content-retention] onsite problem cleanup failed', {
        problemId: problem.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('[content-retention] cleanup complete', result);
  return result;
}

export function getNextRetentionRunAt(now = new Date()): Date {
  const next = new Date(now);
  next.setHours(RETENTION_RUN_HOUR, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

export function startDailyContentRetention(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (): void => {
    if (stopped) {
      return;
    }

    const delay = Math.max(0, getNextRetentionRunAt().getTime() - Date.now());
    timer = setTimeout(async () => {
      try {
        await cleanupExpiredContent();
      } catch (error) {
        console.error('[content-retention] scheduled cleanup failed', error);
      } finally {
        schedule();
      }
    }, delay);

    timer.unref?.();
  };

  const runAndSchedule = async (): Promise<void> => {
    try {
      await cleanupExpiredContent();
    } catch (error) {
      console.error('[content-retention] scheduled cleanup failed', error);
    } finally {
      schedule();
    }
  };

  const now = new Date();
  const todayRunAt = new Date(now);
  todayRunAt.setHours(RETENTION_RUN_HOUR, 0, 0, 0);

  // A server started after today's scheduled time performs the missed run
  // immediately. This keeps a restart from silently losing a daily pass.
  if (now.getTime() >= todayRunAt.getTime()) {
    void runAndSchedule();
  } else {
    schedule();
  }

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
