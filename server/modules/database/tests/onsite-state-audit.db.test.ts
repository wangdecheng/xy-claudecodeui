/**
 * Onsite state audit repository — append + list contract tests (TDD).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '../connection.js';
import { onsiteProblemsDb } from '../repositories/onsite-problems.db.js';
import { onsiteStateAuditDb } from '../repositories/onsite-state-audit.db.js';
import { initSchemaWithMigrations } from './helpers/test-schema.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'onsite-state-audit-'));
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

test('onsiteStateAuditDb.append 写入并返回 id', async () => {
  await withIsolatedDatabase(() => {
    onsiteProblemsDb.insert(PROBLEM);
    const auditId = onsiteStateAuditDb.append({
      problem_id: 'p1',
      from_status: 'pending_info',
      to_status: 'analyzing',
      reason: 'enough info',
      actor_id: 'user-1',
    });
    assert.ok(auditId > 0);
  });
});

test('onsiteStateAuditDb.listByProblemId 按 id 升序返回所有审计', async () => {
  await withIsolatedDatabase(() => {
    onsiteProblemsDb.insert(PROBLEM);
    onsiteStateAuditDb.append({
      problem_id: 'p1',
      from_status: null,
      to_status: 'pending_info',
      reason: 'created',
      actor_id: 'user-1',
    });
    onsiteStateAuditDb.append({
      problem_id: 'p1',
      from_status: 'pending_info',
      to_status: 'analyzing',
      reason: 'enough info',
      actor_id: 'user-1',
    });

    const rows = onsiteStateAuditDb.listByProblemId('p1');
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.to_status, 'pending_info');
    assert.equal(rows[1]!.to_status, 'analyzing');
  });
});