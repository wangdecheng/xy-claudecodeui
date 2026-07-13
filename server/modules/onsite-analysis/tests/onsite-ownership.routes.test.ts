/**
 * TDD permission matrix for onsite problem ownership.
 *
 * Production implementation is intentionally absent in the Red phase. These
 * tests pin stable problem ownership, authenticated actor attribution, and
 * 403 responses across every public :id sub-resource.
 *
 * Run after coverage confirmation:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
 *     server/modules/onsite-analysis/tests/onsite-ownership.routes.test.ts
 */

import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request, { type Response } from 'supertest';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { onsiteFilesDb } from '@/modules/database/repositories/onsite-files.db.js';
import { onsiteStateAuditDb } from '@/modules/database/repositories/onsite-state-audit.db.js';
import { userDb } from '@/modules/database/repositories/users.js';
import { initSchemaWithMigrations } from '@/modules/database/tests/helpers/test-schema.js';

import onsiteRoutes from '../onsite.routes.js';
import { _setConfigForTests, resetConfig, type ConfigPayload } from '../config.service.js';
import { messagesStore } from '../messages-store.service.js';
import { problemService, type ProblemRecord } from '../problem.service.js';

type TestUser = { id: number; username: string };

const sampleConfig: ConfigPayload = {
  status: 'OK',
  mtime: new Date().toISOString(),
  data: {
    customers: [{ label: '山西公安', branch: 'master_5.2_3.2' }],
    iterations: ['master_5.2_3.2'],
  },
};

function buildApp(user: TestUser): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: TestUser }).user = user;
    next();
  });
  app.use('/api/onsite', onsiteRoutes);
  return app;
}

async function withIsolatedEnv(
  runTest: (users: { alice: TestUser; bob: TestUser }) => Promise<void>,
): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousRoot = process.env.ONSITE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'onsite-ownership-routes-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  process.env.ONSITE_ROOT = path.join(tempDir, 'onsite');

  closeConnection();
  initSchemaWithMigrations();
  _setConfigForTests(sampleConfig);
  messagesStore._clearAllForTests();

  const aliceRow = userDb.createUser('owner-alice', 'hash');
  const bobRow = userDb.createUser('other-bob', 'hash');
  const users = {
    alice: { id: Number(aliceRow.id), username: 'owner-alice' },
    bob: { id: Number(bobRow.id), username: 'other-bob' },
  };

  try {
    await runTest(users);
  } finally {
    messagesStore._clearAllForTests();
    resetConfig();
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    if (previousRoot === undefined) delete process.env.ONSITE_ROOT;
    else process.env.ONSITE_ROOT = previousRoot;
    await rm(tempDir, { recursive: true, force: true });
  }
}

let problemSequence = 0;

async function createOwnedProblem(owner: TestUser, label = 'owned'): Promise<ProblemRecord> {
  problemSequence += 1;
  return problemService.create({
    customer: `OwnerCo-${label}-${problemSequence}`,
    third_bridge_branch: null,
    iteration: 'master_5.2_3.2',
    database: 'db01',
    cwd: `${process.env.ONSITE_ROOT}/OwnerCo-${label}-${problemSequence}`,
    description: `owner permission test ${label} ${problemSequence}`,
    userId: owner.id,
  });
}

function assertForbidden(response: Response): void {
  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'PROBLEM_FORBIDDEN');
  const serialized = JSON.stringify(response.body);
  for (const forbiddenField of ['owner_user_id', 'customer', 'cwd', 'files', 'messages']) {
    assert.ok(
      !serialized.includes(forbiddenField),
      `403 body 不得泄露字段 ${forbiddenField}: ${serialized}`,
    );
  }
}

test('POST /problems 只使用认证用户写 owner，忽略客户端伪造 owner_user_id', async () => {
  await withIsolatedEnv(async ({ alice, bob }) => {
    const response = await request(buildApp(alice))
      .post('/api/onsite/problems')
      .send({
        customer: '山西公安',
        third_bridge_branch: 'master_5.2_3.2',
        iteration: 'master_5.2_3.2',
        database: 'db01',
        cwd: `${process.env.ONSITE_ROOT}/山西公安`,
        description: '客户端伪造 owner 不能生效',
        owner_user_id: bob.id,
      });

    assert.equal(response.status, 201);
    const row = getConnection()
      .prepare('SELECT owner_user_id FROM onsite_problems WHERE id = ?')
      .get(response.body.id) as { owner_user_id: number };
    assert.equal(row.owner_user_id, alice.id);
  });
});

test('owner 可以读取自己的详情、附件和消息', async () => {
  await withIsolatedEnv(async ({ alice }) => {
    const problem = await createOwnedProblem(alice, 'owner-read');
    const ownerRow = getConnection()
      .prepare('SELECT owner_user_id FROM onsite_problems WHERE id = ?')
      .get(problem.id) as { owner_user_id: number };
    assert.equal(ownerRow.owner_user_id, alice.id, '正常访问必须建立在稳定 problem owner 上');
    onsiteFilesDb.insert({
      id: 'owner-file',
      problem_id: problem.id,
      original_name: 'owner-log.zip',
      stored_path: '/tmp/owner-log.zip',
      size: 10,
      kind: 'archive',
      unpacked_dir: null,
    });

    const app = buildApp(alice);
    assert.equal(
      (await request(app).get(`/api/onsite/problems/${encodeURIComponent(problem.id)}`)).status,
      200,
    );
    assert.equal(
      (await request(app).get(`/api/onsite/problems/${encodeURIComponent(problem.id)}/files`)).status,
      200,
    );
    assert.equal(
      (await request(app).get(`/api/onsite/problems/${encodeURIComponent(problem.id)}/messages`)).status,
      200,
    );
  });
});

test('非 owner 读取详情、附件和消息统一返回无敏感信息的 403', async (t) => {
  await withIsolatedEnv(async ({ alice, bob }) => {
    const problem = await createOwnedProblem(alice, 'forbidden-read');
    onsiteFilesDb.insert({
      id: 'secret-file',
      problem_id: problem.id,
      original_name: 'customer-secret.zip',
      stored_path: '/tmp/customer-secret.zip',
      size: 10,
      kind: 'archive',
      unpacked_dir: null,
    });
    messagesStore.append({
      problemId: problem.id,
      role: 'assistant',
      kind: 'text',
      content: 'customer secret message',
      ts: Date.now(),
    });

    const app = buildApp(bob);
    const paths = [
      `/api/onsite/problems/${encodeURIComponent(problem.id)}`,
      `/api/onsite/problems/${encodeURIComponent(problem.id)}/files`,
      `/api/onsite/problems/${encodeURIComponent(problem.id)}/messages`,
    ];
    for (const url of paths) {
      await t.test(`GET ${url}`, async () => {
        assertForbidden(await request(app).get(url));
      });
    }
  });
});

test('owner_user_id 为 NULL 的待认领问题对任何普通用户返回 403', async () => {
  await withIsolatedEnv(async ({ alice }) => {
    const problem = await createOwnedProblem(alice, 'unowned-direct');
    getConnection()
      .prepare('UPDATE onsite_problems SET owner_user_id = NULL WHERE id = ?')
      .run(problem.id);

    assertForbidden(
      await request(buildApp(alice)).get(
        `/api/onsite/problems/${encodeURIComponent(problem.id)}`,
      ),
    );
  });
});

test('非 owner 修改、确认根因、上传和删除统一在业务处理前返回 403', async (t) => {
  await withIsolatedEnv(async ({ alice, bob }) => {
    const app = buildApp(bob);

    await t.test('PATCH status', async () => {
      const problem = await createOwnedProblem(alice, 'forbidden-patch');
      const response = await request(app)
        .patch(`/api/onsite/problems/${encodeURIComponent(problem.id)}`)
        .send({ status: 'blocked', reason: '非 owner 不允许修改状态' });
      assertForbidden(response);
    });

    await t.test('POST confirm-root-cause', async () => {
      const problem = await createOwnedProblem(alice, 'forbidden-confirm');
      const response = await request(app)
        .post(`/api/onsite/problems/${encodeURIComponent(problem.id)}/confirm-root-cause`)
        .send({
          root_cause_text: '明确的根因结论',
          reason: '非 owner 不允许确认根因',
        });
      assertForbidden(response);
    });

    await t.test('POST files 在 Multer/NO_FILES 校验前拒绝', async () => {
      const problem = await createOwnedProblem(alice, 'forbidden-upload');
      const response = await request(app)
        .post(`/api/onsite/problems/${encodeURIComponent(problem.id)}/files`);
      assertForbidden(response);
    });

    await t.test('DELETE problem', async () => {
      const problem = await createOwnedProblem(alice, 'forbidden-delete');
      const response = await request(app)
        .delete(`/api/onsite/problems/${encodeURIComponent(problem.id)}`);
      assertForbidden(response);
      assert.ok(
        getConnection().prepare('SELECT id FROM onsite_problems WHERE id = ?').get(problem.id),
        '越权 DELETE 后问题必须仍存在',
      );
    });
  });
});

test('PATCH 审计 actor 强制使用认证用户，不接受请求体 actor_id', async () => {
  await withIsolatedEnv(async ({ alice, bob }) => {
    const problem = await createOwnedProblem(alice, 'audit-actor');
    const response = await request(buildApp(alice))
      .patch(`/api/onsite/problems/${encodeURIComponent(problem.id)}`)
      .send({
        status: 'blocked',
        reason: 'owner 合法修改并记录真实 actor',
        actor_id: String(bob.id),
      });

    assert.equal(response.status, 200);
    const audits = onsiteStateAuditDb.listByProblemId(problem.id);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.actor_id, String(alice.id));
  });
});
