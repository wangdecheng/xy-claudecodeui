/**
 * root_cause_text column — TDD for Sub-task E (Batch 5 cleanup).
 *
 * Covers:
 *  - migrate adds root_cause_text column to onsite_problems
 *  - onsiteProblemsDb.updateRootCause writes the root_cause_text column (not problem.json file)
 *  - onsite-problems.db.ts no longer imports require('node:fs')
 *  - new ONSITE_MIGRATION_STEPS entry '006_add_root_cause_text' exists
 *  - migrations apply cleanly with the new step (no SHA drift)
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initSchemaWithMigrations } from './helpers/test-schema.js';
import { onsiteProblemsDb } from '@/modules/database/repositories/onsite-problems.db.js';

type ColumnInfoRow = { name: string };

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'root-cause-'));
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

test('migrate adds root_cause_text column to onsite_problems', async () => {
  await withIsolatedDatabase(() => {
    const cols = getConnection().prepare("PRAGMA table_info(onsite_problems)").all() as ColumnInfoRow[];
    const names = cols.map((c) => c.name);
    assert.ok(names.includes('root_cause_text'), `root_cause_text 列必须存在,实际: ${names.join(',')}`);
  });
});

test('ONSITE_MIGRATION_STEPS 包含 006_add_root_cause_text', async () => {
  const { ONSITE_MIGRATION_STEPS } = await import('@/modules/database/migrations.js');
  const names = ONSITE_MIGRATION_STEPS.map((s) => s.name);
  assert.ok(
    names.includes('006_add_root_cause_text'),
    `必须含 006_add_root_cause_text step,实际: ${names.join(',')}`,
  );
});

test('updateRootCause 写 root_cause_text 列(不是 problem.json)', async () => {
  await withIsolatedDatabase(() => {
    onsiteProblemsDb.insert({
      id: '20260704-foo',
      customer: 'foo',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      status: 'analyzing',
      cwd: '/tmp/cwd',
      problem_json_path: null, // 即使为 null 也要能写
    });

    onsiteProblemsDb.updateRootCause('20260704-foo', 'Connection pool exhausted under load');

    const row = onsiteProblemsDb.findById('20260704-foo');
    assert.ok(row);
    assert.equal(
      (row as unknown as { root_cause_text?: string }).root_cause_text,
      'Connection pool exhausted under load',
    );
  });
});

test('updateRootCause 不抛 when problem_json_path is null', async () => {
  await withIsolatedDatabase(() => {
    onsiteProblemsDb.insert({
      id: '20260704-bar',
      customer: 'bar',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      status: 'analyzing',
      cwd: '/tmp/cwd',
      problem_json_path: null,
    });
    assert.doesNotThrow(() => {
      onsiteProblemsDb.updateRootCause('20260704-bar', 'some root cause');
    });
  });
});

test('onsite-problems.db.ts 不再 require node:fs', async () => {
  // Read the source file as text and verify no `require('node:fs')` literal exists.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const repoRoot = process.cwd();
  const repoSrc = path.join(repoRoot, 'server/modules/database/repositories/onsite-problems.db.ts');
  const content = await fs.readFile(repoSrc, 'utf8');
  assert.ok(
    !content.includes("require('node:fs')"),
    'onsite-problems.db.ts 仍含 require(\'node:fs\'),应移除',
  );
  // Should also not have any `require(` for fs
  assert.ok(
    !/require\(['"]node:fs['"]\)/.test(content),
    'onsite-problems.db.ts 不应再 require node:fs',
  );
});