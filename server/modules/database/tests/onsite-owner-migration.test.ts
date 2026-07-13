/**
 * TDD contract for onsite problem ownership.
 *
 * This file intentionally tests the public startup migration boundary instead
 * of a private helper: a real application restart must add the owner column,
 * backfill only unambiguous rows by cwd, and remain idempotent.
 *
 * Run after Red confirmation:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
 *     server/modules/database/tests/onsite-owner-migration.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initSchemaWithMigrations } from '@/modules/database/tests/helpers/test-schema.js';

type OwnerRow = { id: string; owner_user_id: number | null };

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'onsite-owner-migration-'));
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');

  closeConnection();
  initSchemaWithMigrations();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function insertUser(id: number, username: string): void {
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(id, username, 'hash');
}

function insertProblem(id: string, cwd: string): void {
  getConnection()
    .prepare(
      `INSERT INTO onsite_problems
         (id, customer, iteration, database, status, cwd, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, 'test', 'release-test', 'mysql', 'analyzing', cwd, 'migration test');
}

function insertOnsiteSession(sessionId: string, cwd: string, userId: number | null): void {
  getConnection()
    .prepare(
      `INSERT INTO sessions (session_id, provider, kind, cwd, user_id)
       VALUES (?, 'claude', 'onsite', ?, ?)`,
    )
    .run(sessionId, cwd, userId);
}

function readOwner(problemId: string): number | null {
  const row = getConnection()
    .prepare('SELECT id, owner_user_id FROM onsite_problems WHERE id = ?')
    .get(problemId) as OwnerRow;
  return row.owner_user_id;
}

test('fresh schema 包含 nullable owner_user_id 和 owner 查询索引', async () => {
  await withIsolatedDatabase(() => {
    const columns = getConnection()
      .prepare('PRAGMA table_info(onsite_problems)')
      .all() as Array<{ name: string; notnull: number }>;
    const ownerColumn = columns.find((column) => column.name === 'owner_user_id');

    assert.ok(ownerColumn, 'onsite_problems.owner_user_id 必须存在');
    assert.equal(ownerColumn.notnull, 0, '迁移期 owner 列必须允许 NULL 表示待认领');

    const indexes = getConnection()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'onsite_problems'")
      .all() as Array<{ name: string }>;
    assert.ok(
      indexes.some((index) => index.name === 'idx_onsite_problems_owner_updated'),
      '必须有 owner + updated_at 列表索引',
    );
  });
});

test('启动迁移按 cwd 回填唯一非空 session owner，session_id 是否为 UUID 不影响结果', async () => {
  await withIsolatedDatabase(() => {
    insertUser(11, 'alice');
    insertProblem('20260713-AliceCo', '/onsite/20260713-AliceCo');
    insertOnsiteSession(
      '11111111-2222-4333-8444-555555555555',
      '/onsite/20260713-AliceCo',
      11,
    );

    closeConnection();
    initSchemaWithMigrations();

    assert.equal(readOwner('20260713-AliceCo'), 11);
  });
});

test('启动迁移不猜测 NULL owner 和多 owner 冲突，二次执行仍保持隔离', async () => {
  await withIsolatedDatabase(() => {
    insertUser(21, 'alice');
    insertUser(22, 'bob');

    insertProblem('unowned-null', '/onsite/unowned-null');
    insertOnsiteSession('null-session', '/onsite/unowned-null', null);

    insertProblem('owner-conflict', '/onsite/owner-conflict');
    insertOnsiteSession('conflict-a', '/onsite/owner-conflict', 21);
    insertOnsiteSession('conflict-b', '/onsite/owner-conflict', 22);

    closeConnection();
    initSchemaWithMigrations();
    closeConnection();
    initSchemaWithMigrations();

    assert.equal(readOwner('unowned-null'), null, 'NULL session owner 不能归给首用户');
    assert.equal(readOwner('owner-conflict'), null, '同一 cwd 多 owner 时不能猜测归属');
  });
});

test('启动迁移不覆盖已确定或人工修正的 problem owner', async () => {
  await withIsolatedDatabase(() => {
    insertUser(31, 'original-owner');
    insertUser(32, 'session-owner');
    insertProblem('pre-owned', '/onsite/pre-owned');
    getConnection()
      .prepare('UPDATE onsite_problems SET owner_user_id = ? WHERE id = ?')
      .run(31, 'pre-owned');
    insertOnsiteSession('provider-uuid', '/onsite/pre-owned', 32);

    closeConnection();
    initSchemaWithMigrations();

    assert.equal(readOwner('pre-owned'), 31, '迁移只能回填 NULL，不能覆盖已有 owner');
  });
});
