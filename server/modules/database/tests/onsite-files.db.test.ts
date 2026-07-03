/**
 * Onsite files repository — CRUD contract tests (TDD).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '../connection.js';
import { onsiteFilesDb } from '../repositories/onsite-files.db.js';
import { onsiteProblemsDb } from '../repositories/onsite-problems.db.js';
import { initSchemaWithMigrations } from './helpers/test-schema.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'onsite-files-'));
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

const PROBLEM = {
  id: 'p1',
  customer: 'cust',
  third_bridge_branch: 'master_5.2_3.2',
  iteration: 'master_5.2_3.2',
  database: 'db01',
  status: 'pending_info',
  cwd: '/c1',
  problem_json_path: '/c1/problem.json',
};

const FILE = {
  id: 'f1',
  problem_id: 'p1',
  original_name: 'server.log',
  stored_path: '/storage/f1.log',
  size: 1024,
  kind: 'log',
  unpacked_dir: null as string | null,
};

test('onsiteFilesDb.insert 返回 id', async () => {
  await withIsolatedDatabase(() => {
    onsiteProblemsDb.insert(PROBLEM);
    const id = onsiteFilesDb.insert(FILE);
    assert.equal(id, FILE.id);
  });
});

test('onsiteFilesDb.findById 找到记录', async () => {
  await withIsolatedDatabase(() => {
    onsiteProblemsDb.insert(PROBLEM);
    onsiteFilesDb.insert(FILE);
    const row = onsiteFilesDb.findById(FILE.id);
    assert.ok(row);
    assert.equal(row?.original_name, 'server.log');
    assert.equal(row?.size, 1024);
  });
});

test('onsiteFilesDb.findByProblemId 列出该问题下所有文件', async () => {
  await withIsolatedDatabase(() => {
    onsiteProblemsDb.insert(PROBLEM);
    onsiteFilesDb.insert(FILE);
    onsiteFilesDb.insert({ ...FILE, id: 'f2', original_name: 'app.log' });

    const rows = onsiteFilesDb.findByProblemId('p1');
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => r.original_name === 'server.log'));
    assert.ok(rows.some((r) => r.original_name === 'app.log'));
  });
});

test('onsiteFilesDb.list 返回全部文件', async () => {
  await withIsolatedDatabase(() => {
    onsiteProblemsDb.insert(PROBLEM);
    onsiteFilesDb.insert(FILE);
    const rows = onsiteFilesDb.list();
    assert.equal(rows.length, 1);
  });
});