/**
 * Onsite problems repository — CRUD contract tests (TDD).
 *
 * Covers:
 *  - insert returns id
 *  - findById / findByCwd
 *  - list sorted by created_at desc
 *  - updateStatus + updateMtime
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '../connection.js';
import { onsiteProblemsDb } from '../repositories/onsite-problems.db.js';
import { initSchemaWithMigrations } from './helpers/test-schema.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'onsite-problems-'));
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

const SAMPLE = {
  id: 'p-2026-07-03-cust',
  customer: '山西公安',
  third_bridge_branch: 'master_5.2_3.2',
  iteration: 'master_5.2_3.2',
  database: 'db01',
  status: 'pending_info',
  cwd: '/tmp/customer-onsite-analysis/20260703-cust',
  problem_json_path: '/tmp/customer-onsite-analysis/20260703-cust/problem.json',
};

test('onsiteProblemsDb.insert 返回 id', async () => {
  await withIsolatedDatabase(() => {
    const id = onsiteProblemsDb.insert(SAMPLE);
    assert.equal(id, SAMPLE.id);
  });
});

test('onsiteProblemsDb.findById 返回完整记录', async () => {
  await withIsolatedDatabase(() => {
    onsiteProblemsDb.insert(SAMPLE);
    const row = onsiteProblemsDb.findById(SAMPLE.id);
    assert.ok(row);
    assert.equal(row?.customer, SAMPLE.customer);
    assert.equal(row?.database, SAMPLE.database);
    assert.equal(row?.status, 'pending_info');
    assert.equal(row?.cwd, SAMPLE.cwd);
  });
});

test('onsiteProblemsDb.findById 找不到时返回 null', async () => {
  await withIsolatedDatabase(() => {
    const row = onsiteProblemsDb.findById('does-not-exist');
    assert.equal(row, null);
  });
});

test('onsiteProblemsDb.findByCwd 找到匹配记录', async () => {
  await withIsolatedDatabase(() => {
    onsiteProblemsDb.insert(SAMPLE);
    const row = onsiteProblemsDb.findByCwd(SAMPLE.cwd);
    assert.ok(row);
    assert.equal(row?.id, SAMPLE.id);
  });
});

test('onsiteProblemsDb.list 返回全部记录', async () => {
  await withIsolatedDatabase(() => {
    onsiteProblemsDb.insert({ ...SAMPLE, id: 'p1', cwd: '/c1' });
    onsiteProblemsDb.insert({ ...SAMPLE, id: 'p2', cwd: '/c2' });
    onsiteProblemsDb.insert({ ...SAMPLE, id: 'p3', cwd: '/c3' });

    const list = onsiteProblemsDb.list();
    assert.equal(list.length, 3);
    assert.ok(list.every((item) => typeof item.customer === 'string'));
  });
});

test('onsiteProblemsDb.updateStatus 改 status 且刷 updated_at', async () => {
  await withIsolatedDatabase(() => {
    onsiteProblemsDb.insert(SAMPLE);
    const before = onsiteProblemsDb.findById(SAMPLE.id);
    assert.equal(before?.status, 'pending_info');

    onsiteProblemsDb.updateStatus(SAMPLE.id, 'analyzing', 'enough info gathered', 'user-1');

    const after = onsiteProblemsDb.findById(SAMPLE.id);
    assert.equal(after?.status, 'analyzing');
    assert.ok(after?.updated_at);
  });
});

test('onsiteProblemsDb.updateMtime 写入 mtime', async () => {
  await withIsolatedDatabase(() => {
    onsiteProblemsDb.insert(SAMPLE);
    onsiteProblemsDb.updateMtime(SAMPLE.id, '2026-07-03T12:34:56.000Z');
    const row = onsiteProblemsDb.findById(SAMPLE.id);
    assert.equal(row?.mtime, '2026-07-03T12:34:56.000Z');
  });
});