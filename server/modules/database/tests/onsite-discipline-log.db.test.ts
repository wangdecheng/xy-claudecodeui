/**
 * Onsite discipline log repository — append + count contract tests (TDD).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '../connection.js';
import { onsiteDisciplineLogDb } from '../repositories/onsite-discipline-log.db.js';
import { onsiteProblemsDb } from '../repositories/onsite-problems.db.js';
import { initSchemaWithMigrations } from './helpers/test-schema.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'onsite-discipline-log-'));
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

test('onsiteDisciplineLogDb.append 返回 id', async () => {
  await withIsolatedDatabase(() => {
    onsiteProblemsDb.insert(PROBLEM);
    const id = onsiteDisciplineLogDb.append({
      problem_id: 'p1',
      message_id: 'm1',
      kind: 'softening',
      word: '可能',
      position: 12,
      cmd: null,
      stdout_preview: null,
    });
    assert.ok(id > 0);
  });
});

test('onsiteDisciplineLogDb.countByProblemId 返回指定问题的日志数', async () => {
  await withIsolatedDatabase(() => {
    onsiteProblemsDb.insert(PROBLEM);
    onsiteDisciplineLogDb.append({
      problem_id: 'p1',
      message_id: 'm1',
      kind: 'softening',
      word: '可能',
      position: 1,
      cmd: null,
      stdout_preview: null,
    });
    onsiteDisciplineLogDb.append({
      problem_id: 'p1',
      message_id: 'm2',
      kind: 'write-protection',
      word: null,
      position: null,
      cmd: 'rm foo.log',
      stdout_preview: '',
    });
    const count = onsiteDisciplineLogDb.countByProblemId('p1');
    assert.equal(count, 2);
  });
});

test('onsiteDisciplineLogDb.countByProblemId 在不存在的问题上返回 0', async () => {
  await withIsolatedDatabase(() => {
    const count = onsiteDisciplineLogDb.countByProblemId('missing');
    assert.equal(count, 0);
  });
});