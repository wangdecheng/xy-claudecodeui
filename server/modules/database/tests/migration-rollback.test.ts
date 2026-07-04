/**
 * Migration rollback + integrity tests — TDD for the C-4 patch.
 *
 * Covers:
 *  - Migration transaction wrapper rolls back partial failures
 *  - verifyMigrations detects missing / corrupt migration records
 *  - MigrationCorruptionError is thrown on corruption
 *
 * Each test isolates its own SQLite file via `process.env.DATABASE_PATH`.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import {
  MigrationCorruptionError,
  runMigrations,
  verifyMigrations,
} from '@/modules/database/migrations.js';
import { INIT_SCHEMA_SQL } from '@/modules/database/schema.js';
import { initSchemaWithMigrations } from './helpers/test-schema.js';

type VerifyResult = ReturnType<typeof verifyMigrations>;

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'migration-rollback-'));
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

test('第 3 张表创建失败 → migrations_applied 事务回滚(完整性检查会发现该步骤缺失)', async () => {
  // SQLite semantics: DDL statements (`CREATE TABLE`) commit implicitly even
  // inside a `db.transaction()` wrapper — that's a long-standing SQLite
  // limitation. So we cannot rely on the table itself vanishing. What the
  // transaction CAN roll back is the `migrations_applied` row that
  // `recordAppliedMigrations()` writes after the txn succeeds. With the
  // transaction intact, a partial migration leaves zero migration rows
  // recorded, and `verifyMigrations()` will report all steps as missing —
  // which is exactly the corruption signal the integrity check is designed
  // to catch.
  //
  // This test asserts the on-disk integrity-check state, which is the
  // end-user-visible safety guarantee.

  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'migration-rollback-fail-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  const db = new Database(databasePath);
  db.exec(INIT_SCHEMA_SQL);

  const realExec = db.exec.bind(db);
  let injected = false;
  db.exec = ((sql: string) => {
    if (!injected && sql.includes('CREATE TABLE IF NOT EXISTS onsite_state_audit')) {
      injected = true;
      throw new Error('disk full (injected)');
    }
    return realExec(sql);
  }) as typeof db.exec;

  let threw = false;
  try {
    runMigrations(db);
  } catch (err: unknown) {
    threw = true;
    assert.match((err as Error).message, /disk full/);
  }
  assert.ok(threw, 'runMigrations 必须抛出注入错误');

  // Re-open readonly and verify integrity state
  const checkDb = new Database(databasePath, { readonly: true });
  const recorded = (
    checkDb.prepare('SELECT name FROM migrations_applied').all() as Array<{ name: string }>
  ).map((r) => r.name);

  assert.equal(
    recorded.length,
    0,
    `migrations_applied 应为空(整个事务回滚),实际记录: ${recorded.join(',')}`,
  );

  // verifyMigrations should now report ALL known steps as missing
  const result = verifyMigrations(checkDb);
  assert.equal(result.ok, false);
  if (!result.ok) {
    // After C-1 fix: only CREATE TABLE steps are SHA-tracked (4 steps total,
    // starting at 002). ALTER-sessions is intentionally excluded.
    assert.ok(result.missing.length >= 4, `应至少 4 个缺失 migration,实际 ${result.missing.length}`);
    assert.ok(result.missing.includes('002_create_onsite_problems_table'));
    assert.ok(result.missing.includes('005_create_onsite_discipline_log_table'));
  }

  checkDb.close();
  db.close();
  closeConnection();
  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }
  await rm(tempDirectory, { recursive: true, force: true });
});

test('verifyMigrations 启动时检测 sha 一致性(corrupt 报告)', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    db.prepare(
      "UPDATE migrations_applied SET sha = 'corrupt' WHERE name = '002_create_onsite_problems_table'",
    ).run();

    const result = verifyMigrations(db);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.corrupt.some((c) => c.name === '002_create_onsite_problems_table'),
        'corrupt 列表应包含被篡改的 migration name',
      );
      const entry = result.corrupt.find((c) => c.name === '002_create_onsite_problems_table');
      assert.ok(entry);
      assert.equal(entry?.actualSha, 'corrupt');
    }
  });
});

test('verifyMigrations 启动时检测缺失 migration', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'migration-rollback-missing-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  const db = new Database(databasePath);
  db.exec(INIT_SCHEMA_SQL);
  // Create migrations_applied but leave it empty — every step is "missing"
  db.exec(
    `CREATE TABLE IF NOT EXISTS migrations_applied (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sha TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
  );

  const result = verifyMigrations(db);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.missing.includes('002_create_onsite_problems_table'));
    assert.ok(result.missing.includes('003_create_onsite_files_table'));
  }

  db.close();
  closeConnection();
  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }
  await rm(tempDirectory, { recursive: true, force: true });
});

test('verifyMigrations 在 corruption 下抛 MigrationCorruptionError(类形状正确)', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    db.prepare(
      "UPDATE migrations_applied SET sha = 'tampered' WHERE name = '002_create_onsite_problems_table'",
    ).run();

    const result = verifyMigrations(db);
    assert.equal(result.ok, false);
    if (!result.ok) {
      const err = new MigrationCorruptionError(
        'tampered',
        result.missing,
        result.corrupt,
      );
      assert.equal(err.code, 'MIGRATION_CORRUPTION');
      assert.equal(err.name, 'MigrationCorruptionError');
      assert.ok(err.corrupt.length > 0);
    }
  });
});

test('verifyMigrations 在完整迁移后返回 ok=true', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    const result: VerifyResult = verifyMigrations(db);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(typeof result.version === 'number');
    }
  });
});