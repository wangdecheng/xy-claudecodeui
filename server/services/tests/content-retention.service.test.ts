import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import type { OnsiteProblemRecord } from '@/modules/database/repositories/onsite-problems.db.js';
import type { SessionRetentionRecord } from '@/modules/database/repositories/sessions.db.js';

import {
  cleanupExpiredContent,
  getNextRetentionRunAt,
  RETENTION_PERIOD_MS,
  type ContentRetentionRoots,
} from '../content-retention.service.js';

const NOW = new Date('2026-07-27T12:00:00.000Z');
const OLD_TIMESTAMP = new Date(NOW.getTime() - RETENTION_PERIOD_MS - 1).toISOString();

const roots: ContentRetentionRoots = {
  claudeHome: '/tmp/content-retention/.claude',
  cursorProjects: '/tmp/content-retention/.cursor/projects',
  cursorChats: '/tmp/content-retention/.cursor/chats',
  codexSessions: '/tmp/content-retention/.codex/sessions',
  geminiTmp: '/tmp/content-retention/.gemini/tmp',
  onsiteRoot: '/tmp/content-retention/onsite',
};

function session(overrides: Partial<SessionRetentionRecord> = {}): SessionRetentionRecord {
  return {
    session_id: 'session-1',
    provider: 'codex',
    provider_session_id: 'provider-session-1',
    project_path: '/workspace/demo',
    jsonl_path: path.join(roots.codexSessions, 'session-1.jsonl'),
    custom_name: 'Old session',
    isArchived: 0,
    created_at: OLD_TIMESTAMP,
    updated_at: OLD_TIMESTAMP,
    user_id: 1,
    kind: 'chat',
    cwd: null,
    ...overrides,
  };
}

function problem(overrides: Partial<OnsiteProblemRecord> = {}): OnsiteProblemRecord {
  return {
    id: 'problem-1',
    customer: 'Customer',
    third_bridge_branch: null,
    iteration: 'iteration-1',
    database: 'mysql',
    status: 'confirmed',
    cwd: path.join(roots.onsiteRoot, 'problem-1'),
    problem_json_path: path.join(roots.onsiteRoot, 'problem-1', 'problem.json'),
    created_at: OLD_TIMESTAMP,
    updated_at: OLD_TIMESTAMP,
    mtime: null,
    root_cause_text: null,
    description: 'Old problem',
    owner_user_id: 1,
    ...overrides,
  };
}

function silentLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

test('cleanup deletes old non-Claude artifacts before their session indexes', async () => {
  const removed: string[] = [];
  const deleted: string[] = [];

  const result = await cleanupExpiredContent({
    now: NOW,
    roots,
    sessions: [session()],
    problems: [],
    removePath: async (targetPath) => {
      removed.push(targetPath);
    },
    deleteSession: (sessionId) => {
      deleted.push(sessionId);
      return true;
    },
    logger: silentLogger(),
  });

  assert.equal(result.sessionsDeleted, 1);
  assert.deepEqual(deleted, ['session-1']);
  assert.deepEqual(removed, [path.join(roots.codexSessions, 'session-1.jsonl')]);
});

test('cleanup removes old Claude indexes but never removes Claude files', async () => {
  const removed: string[] = [];
  const deleted: string[] = [];

  const result = await cleanupExpiredContent({
    now: NOW,
    roots,
    sessions: [session({
      provider: 'claude',
      jsonl_path: path.join(roots.claudeHome, 'projects', 'encoded', 'session.jsonl'),
    })],
    problems: [],
    removePath: async (targetPath) => {
      removed.push(targetPath);
    },
    deleteSession: (sessionId) => {
      deleted.push(sessionId);
      return true;
    },
    logger: silentLogger(),
  });

  assert.equal(result.sessionsDeleted, 1);
  assert.deepEqual(deleted, ['session-1']);
  assert.deepEqual(removed, []);
});

test('cleanup skips OpenCode and unknown provider indexes', async () => {
  const deleted: string[] = [];

  const result = await cleanupExpiredContent({
    now: NOW,
    roots,
    sessions: [
      session({ session_id: 'opencode', provider: 'opencode', jsonl_path: null }),
      session({ session_id: 'future-provider', provider: 'future-provider', jsonl_path: null }),
    ],
    problems: [],
    removePath: async () => undefined,
    deleteSession: (sessionId) => {
      deleted.push(sessionId);
      return true;
    },
    logger: silentLogger(),
  });

  assert.equal(result.sessionsDeleted, 0);
  assert.equal(result.skipped, 2);
  assert.deepEqual(deleted, []);
});

test('cleanup skips recent, invalid-timestamp, and active sessions', async () => {
  const deleted: string[] = [];

  const result = await cleanupExpiredContent({
    now: NOW,
    roots,
    sessions: [
      session({ session_id: 'recent', updated_at: NOW.toISOString() }),
      session({ session_id: 'invalid', updated_at: 'not-a-date' }),
      session({ session_id: 'active' }),
    ],
    problems: [],
    isSessionActive: (sessionId) => sessionId === 'active',
    removePath: async () => undefined,
    deleteSession: (sessionId) => {
      deleted.push(sessionId);
      return true;
    },
    logger: silentLogger(),
  });

  assert.equal(result.sessionsDeleted, 0);
  assert.equal(result.skipped, 3);
  assert.deepEqual(deleted, []);
});

test('cleanup deletes an old onsite directory before its database row', async () => {
  const removed: string[] = [];
  const deleted: string[] = [];
  const cleared: string[] = [];

  const result = await cleanupExpiredContent({
    now: NOW,
    roots,
    sessions: [],
    problems: [problem()],
    removePath: async (targetPath) => {
      removed.push(targetPath);
    },
    deleteProblem: (problemId) => {
      deleted.push(problemId);
    },
    clearProblemMessages: (problemId) => {
      cleared.push(problemId);
    },
    logger: silentLogger(),
  });

  assert.equal(result.problemsDeleted, 1);
  assert.deepEqual(removed, [path.join(roots.onsiteRoot, 'problem-1')]);
  assert.deepEqual(deleted, ['problem-1']);
  assert.deepEqual(cleared, ['problem-1']);
});

test('cleanup keeps analyzing onsite problems and continues after a failure', async () => {
  const deleted: string[] = [];
  const errors: unknown[] = [];

  const result = await cleanupExpiredContent({
    now: NOW,
    roots,
    sessions: [],
    problems: [
      problem({ id: 'analyzing', status: 'analyzing' }),
      problem({ id: 'locked', cwd: path.join(roots.onsiteRoot, 'locked') }),
      problem({ id: 'successful', cwd: path.join(roots.onsiteRoot, 'successful') }),
    ],
    removePath: async (targetPath) => {
      if (targetPath.endsWith('/locked')) {
        throw new Error('directory is locked');
      }
    },
    deleteProblem: (problemId) => {
      deleted.push(problemId);
    },
    logger: {
      ...silentLogger(),
      error: (...args: unknown[]) => errors.push(args),
    },
  });

  assert.equal(result.problemsDeleted, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(deleted, ['successful']);
  assert.equal(errors.length, 1);
});

test('getNextRetentionRunAt returns the next local 12:00', () => {
  assert.equal(
    getNextRetentionRunAt(new Date('2026-07-27T11:59:00.000')).getHours(),
    12,
  );
  assert.equal(
    getNextRetentionRunAt(new Date('2026-07-27T12:00:00.000')).getDate(),
    28,
  );
});
