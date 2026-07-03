/**
 * Onsite schema migration tests — TDD: verify that `runMigrations` produces
 * the new schema required by Batch 2 of the customer-onsite-analysis-ui
 * change:
 *
 *   - sessions.kind column (default 'chat', CHECK constraint chat/onsite)
 *   - sessions.cwd / third_bridge_branch / iteration / database columns
 *   - idx_sessions_kind_cwd index
 *   - 4 new onsite tables: onsite_problems, onsite_files, onsite_state_audit,
 *     onsite_discipline_log
 *
 * `migrations_applied` is verified separately in migration-rollback.test.ts
 * because that table is created earlier (before the migration step list)
 * to back the integrity-check feature.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type Database from 'better-sqlite3';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initSchemaWithMigrations } from './helpers/test-schema.js';

type TableInfoRow = { name: string };
type ColumnInfoRow = { name: string; dflt_value: string | null };

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'onsite-migration-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  initSchemaWithMigrations();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function db(): Database.Database {
  return getConnection();
}

test('sessions 表 kind 列存在且默认值为 chat', async () => {
  await withIsolatedDatabase(() => {
    const cols = db().prepare("PRAGMA table_info(sessions)").all() as ColumnInfoRow[];
    const kind = cols.find((c) => c.name === 'kind');
    assert.ok(kind, 'sessions.kind 必须存在');
    assert.match(kind.dflt_value ?? '', /'chat'/);
  });
});

test('sessions 表含 cwd / third_bridge_branch / iteration / database 列', async () => {
  await withIsolatedDatabase(() => {
    const cols = db().prepare("PRAGMA table_info(sessions)").all() as ColumnInfoRow[];
    const names = cols.map((c) => c.name);
    for (const col of ['cwd', 'third_bridge_branch', 'iteration', 'database']) {
      assert.ok(names.includes(col), `sessions.${col} 必须存在`);
    }
  });
});

test('sessions.kind CHECK 约束限定 chat/onsite', async () => {
  await withIsolatedDatabase(() => {
    // 插入合法值应成功
    db().prepare(`INSERT INTO sessions (session_id, kind) VALUES ('s-ok-chat', 'chat')`).run();
    db().prepare(`INSERT INTO sessions (session_id, kind) VALUES ('s-ok-onsite', 'onsite')`).run();
    // 非法值应失败
    assert.throws(() => {
      db().prepare(`INSERT INTO sessions (session_id, kind) VALUES ('s-bad', 'bogus')`).run();
    }, /CHECK constraint failed/i);
  });
});

test('4 张 onsite 业务表全部存在', async () => {
  await withIsolatedDatabase(() => {
    const expected = [
      'onsite_problems',
      'onsite_files',
      'onsite_state_audit',
      'onsite_discipline_log',
    ];
    for (const table of expected) {
      const row = db()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table) as TableInfoRow | undefined;
      assert.ok(row, `表 ${table} 必须存在`);
    }
  });
});

test('onsite 表关键索引存在', async () => {
  await withIsolatedDatabase(() => {
    const expected = [
      'idx_sessions_kind_cwd',
      'idx_onsite_problems_cwd',
      'idx_onsite_problems_status',
      'idx_onsite_files_problem_id',
      'idx_onsite_state_audit_problem_id',
      'idx_onsite_discipline_log_problem_id',
    ];
    for (const idx of expected) {
      const row = db()
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
        .get(idx) as TableInfoRow | undefined;
      assert.ok(row, `索引 ${idx} 必须存在`);
    }
  });
});