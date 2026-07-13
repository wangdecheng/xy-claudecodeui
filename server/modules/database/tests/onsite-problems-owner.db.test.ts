/** Repository contracts for owner-based onsite problem authorization. */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { onsiteProblemsDb } from '@/modules/database/repositories/onsite-problems.db.js';
import { initSchemaWithMigrations } from '@/modules/database/tests/helpers/test-schema.js';

type AccessRecord = { id: string; owner_user_id: number | null; cwd: string };
type OwnerListItem = { id: string; owner_user_id: number | null };
type OwnerRepository = {
  findAccessRecord(id: string): AccessRecord | null;
  listByOwner(ownerUserId: number): OwnerListItem[];
};

const ownerRepository = onsiteProblemsDb as unknown as OwnerRepository;

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'onsite-problem-owner-db-'));
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

function seedUser(id: number, username: string): void {
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(id, username, 'hash');
}

function seedProblem(id: string, ownerUserId: number | null): void {
  getConnection()
    .prepare(
      `INSERT INTO onsite_problems
         (id, customer, iteration, database, status, cwd, description, owner_user_id)
       VALUES (?, 'test', 'release-test', 'mysql', 'analyzing', ?, '', ?)`,
    )
    .run(id, `/onsite/${id}`, ownerUserId);
}

test('findAccessRecord 只返回授权所需的稳定 owner 与 cwd', async () => {
  await withIsolatedDatabase(() => {
    seedUser(1, 'alice');
    seedProblem('alice-problem', 1);

    assert.deepEqual(ownerRepository.findAccessRecord('alice-problem'), {
      id: 'alice-problem',
      owner_user_id: 1,
      cwd: '/onsite/alice-problem',
    });
    assert.equal(ownerRepository.findAccessRecord('missing'), null);
  });
});

test('listByOwner 只返回匹配 owner，排除其他用户和 NULL owner', async () => {
  await withIsolatedDatabase(() => {
    seedUser(1, 'alice');
    seedUser(2, 'bob');
    seedProblem('alice-problem', 1);
    seedProblem('bob-problem', 2);
    seedProblem('unowned-problem', null);

    assert.deepEqual(
      ownerRepository.listByOwner(1).map((problem) => problem.id),
      ['alice-problem'],
    );
    assert.deepEqual(
      ownerRepository.listByOwner(2).map((problem) => problem.id),
      ['bob-problem'],
    );
  });
});
