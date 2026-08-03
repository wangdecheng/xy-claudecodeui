import { createHash } from 'node:crypto';
import { lstat, readdir, rm as removePath } from 'node:fs/promises';
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
export const RETENTION_RUN_HOUR = 12;

type ProviderName = 'claude' | 'cursor' | 'codex' | 'gemini' | 'opencode' | string;

type RetentionPath = {
  path: string;
  root: string;
};

type OnsiteCleanupCandidate = {
  path: string;
  problem: OnsiteProblemRecord | null;
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
const ONSITE_BUSINESS_DIRECTORY_REGEX = /^\d{8}(?:\d{6})?-/;

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

function assertDirectChildWithinRoot(candidatePath: string, rootPath: string, label: string): void {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  const relative = path.relative(root, candidate);
  if (
    relative === ''
    || relative.startsWith('..')
    || path.isAbsolute(relative)
    || relative.includes(path.sep)
  ) {
    throw new Error(`${label} is not a direct child of its managed root: ${candidatePath}`);
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

function getSessionsForOnsitePath(
  onsitePath: string,
  sessions: SessionRetentionRecord[],
): SessionRetentionRecord[] {
  const normalizedPath = path.resolve(onsitePath);
  return sessions.filter(
    (session) => session.cwd !== null && path.resolve(session.cwd) === normalizedPath,
  );
}

function isErrnoException(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function getNewestFilesystemMtime(targetPath: string): Promise<number | null> {
  let targetStat;
  try {
    targetStat = await lstat(targetPath);
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) return null;
    throw error;
  }

  let newestMtime = targetStat.mtimeMs;
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    return newestMtime;
  }

  let entries;
  try {
    entries = await readdir(targetPath, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) return null;
    throw error;
  }

  for (const entry of entries) {
    const childMtime = await getNewestFilesystemMtime(path.join(targetPath, entry.name));
    if (childMtime !== null) {
      newestMtime = Math.max(newestMtime, childMtime);
    }
  }
  return newestMtime;
}

async function getOnsiteCleanupCandidates(
  onsiteRoot: string,
  problems: OnsiteProblemRecord[],
): Promise<OnsiteCleanupCandidate[]> {
  const candidates: OnsiteCleanupCandidate[] = problems.map((problem) => ({
    path: path.resolve(problem.cwd),
    problem,
  }));
  const trackedPaths = new Set(candidates.map((candidate) => candidate.path));

  let entries;
  try {
    entries = await readdir(onsiteRoot, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) return candidates;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !ONSITE_BUSINESS_DIRECTORY_REGEX.test(entry.name)) {
      continue;
    }
    const candidatePath = path.resolve(onsiteRoot, entry.name);
    if (!trackedPaths.has(candidatePath)) {
      candidates.push({ path: candidatePath, problem: null });
    }
  }
  return candidates;
}

async function getOnsiteLastActivity(
  candidate: OnsiteCleanupCandidate,
  sessions: SessionRetentionRecord[],
): Promise<number | null> {
  const timestamps: number[] = [];
  const problemTimestamp = parseTimestamp(candidate.problem?.updated_at);
  if (problemTimestamp !== null) timestamps.push(problemTimestamp);

  for (const session of sessions) {
    const sessionTimestamp = parseTimestamp(session.updated_at);
    if (sessionTimestamp !== null) timestamps.push(sessionTimestamp);
  }

  const filesystemTimestamp = await getNewestFilesystemMtime(candidate.path);
  if (filesystemTimestamp !== null) timestamps.push(filesystemTimestamp);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
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

  for (const session of sessions) {
    const updatedAt = parseTimestamp(session.updated_at);
    if (updatedAt === null || updatedAt >= cutoffTimestamp) {
      result.skipped += 1;
      continue;
    }

    if (isSessionActive(session.session_id)) {
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

  let onsiteCandidates: OnsiteCleanupCandidate[];
  try {
    onsiteCandidates = await getOnsiteCleanupCandidates(roots.onsiteRoot, problems);
    result.problemsScanned = onsiteCandidates.length;
  } catch (error) {
    result.failed += 1;
    logger.error('[content-retention] failed to scan onsite root', {
      onsiteRoot: roots.onsiteRoot,
      error: error instanceof Error ? error.message : String(error),
    });
    onsiteCandidates = problems.map((problem) => ({
      path: path.resolve(problem.cwd),
      problem,
    }));
  }

  for (const candidate of onsiteCandidates) {
    const problemId = candidate.problem?.id ?? path.basename(candidate.path);

    try {
      assertDirectChildWithinRoot(candidate.path, roots.onsiteRoot, 'Onsite problem directory');
      const matchingSessions = getSessionsForOnsitePath(candidate.path, sessions);
      if (matchingSessions.some((session) => isSessionActive(session.session_id))) {
        result.skipped += 1;
        continue;
      }

      const lastActivity = await getOnsiteLastActivity(candidate, matchingSessions);
      if (lastActivity === null || lastActivity >= cutoffTimestamp) {
        result.skipped += 1;
        continue;
      }

      await remove(candidate.path, { recursive: true, force: true });
      if (candidate.problem) {
        deleteProblem(candidate.problem.id);
      }
      clearProblemMessages(problemId);
      result.problemsDeleted += 1;
    } catch (error) {
      result.failed += 1;
      logger.error('[content-retention] onsite problem cleanup failed', {
        problemId,
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
