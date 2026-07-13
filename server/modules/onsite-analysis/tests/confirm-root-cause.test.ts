/**
 * confirm-root-cause endpoint — TDD discipline.
 *
 * Covers:
 *  - 含软化词返 422 + words 列表(不调 StateMachine)
 *  - 干净文本 + 合法 reason 返 200 + StateMachine.apply + broadcast state-changed
 *  - reason < 8 字符返 400
 *  - root_cause_text 空返 400
 *  - problemId 不存在返 404
 *
 * Run:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
 *     server/modules/onsite-analysis/tests/confirm-root-cause.test.ts
 */

import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection } from '@/modules/database/connection.js';
import { userDb } from '@/modules/database/repositories/users.js';
import { initSchemaWithMigrations } from '@/modules/database/tests/helpers/test-schema.js';

import onsiteRoutes from '../onsite.routes.js';
import { onsiteBroadcast } from '../onsite-broadcast.js';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: number; username: string } }).user = {
      id: 1,
      username: 'tester',
    };
    next();
  });
  app.use('/api/onsite', onsiteRoutes);
  return app;
}

async function withIsolatedEnv(runTest: () => Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousRoot = process.env.ONSITE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'confirm-rc-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  process.env.ONSITE_ROOT = path.join(tempDir, 'onsite');
  closeConnection();
  initSchemaWithMigrations();
  userDb.createUser('tester', 'hash');

  try {
    await runTest();
  } finally {
    onsiteBroadcast._resetForTests();
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    if (previousRoot === undefined) delete process.env.ONSITE_ROOT;
    else process.env.ONSITE_ROOT = previousRoot;
    await rm(tempDir, { recursive: true, force: true });
  }
}

const PROBLEM_ID = '20260704-test';

function seedAnalyzingProblem(): void {
  // 直接向 DB 插一行 analyzing 状态(confirmed 需要从 analyzing 进入)
  const db = new Database(process.env.DATABASE_PATH!);
  db.prepare(
    `INSERT INTO onsite_problems
       (id, customer, third_bridge_branch, iteration, database, status, cwd, problem_json_path, owner_user_id)
     VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?)`,
  ).run(PROBLEM_ID, 'test', 'master_5.2_3.2', 'db01', 'analyzing', '/tmp/cwd', 1);
  db.close();
}

test('POST /api/onsite/problems/:id/confirm-root-cause 含软化词返 422 + words 列表', async () => {
  await withIsolatedEnv(async () => {
    seedAnalyzingProblem();
    const app = buildApp();
    const res = await request(app)
      .post(`/api/onsite/problems/${PROBLEM_ID}/confirm-root-cause`)
      .send({
        root_cause_text: '这个 bug 可能是因为 OOM 导致',
        reason: '复现已确认,O 日志可重现',
      });
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'softening_words_present');
    assert.ok(Array.isArray(res.body.words));
    assert.ok(res.body.words.some((w: { word: string }) => w.word === '可能'));
  });
});

test('POST /api/onsite/problems/:id/confirm-root-cause 干净文本 + 合法 reason 返 200 + StateMachine.apply', async () => {
  await withIsolatedEnv(async () => {
    seedAnalyzingProblem();

    // 订阅 broadcast,验证收到 state-changed
    const received: unknown[] = [];
    onsiteBroadcast.subscribe({
      send: (e) => received.push(e),
    });

    const app = buildApp();
    const res = await request(app)
      .post(`/api/onsite/problems/${PROBLEM_ID}/confirm-root-cause`)
      .send({
        root_cause_text: 'O 日志可见 NPE at Main.java:42,根因是 null guard 缺失',
        reason: '复现已确认,O 日志可重现,主线修复在 guard',
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.to, 'confirmed');
    assert.equal(res.body.from, 'analyzing');
    assert.ok(typeof res.body.at === 'string');

    // broadcast 收到 state-changed
    assert.ok(
      received.some(
        (e) =>
          typeof e === 'object' &&
          e !== null &&
          'type' in e &&
          (e as { type: string }).type === `problem:${PROBLEM_ID}:state-changed`,
      ),
      'broadcast 应发出 problem:<id>:state-changed',
    );
  });
});

test('POST /api/onsite/problems/:id/confirm-root-cause reason < 8 字符返 400', async () => {
  await withIsolatedEnv(async () => {
    seedAnalyzingProblem();
    const app = buildApp();
    const res = await request(app)
      .post(`/api/onsite/problems/${PROBLEM_ID}/confirm-root-cause`)
      .send({
        root_cause_text: '干净的根因结论文本',
        reason: '太短',
      });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /REASON/);
  });
});

test('POST /api/onsite/problems/:id/confirm-root-cause root_cause_text 空返 400', async () => {
  await withIsolatedEnv(async () => {
    seedAnalyzingProblem();
    const app = buildApp();
    const res = await request(app)
      .post(`/api/onsite/problems/${PROBLEM_ID}/confirm-root-cause`)
      .send({
        root_cause_text: '',
        reason: '足够长的 reason 字段',
      });
    assert.equal(res.status, 400);
  });
});

test('POST /api/onsite/problems/:id/confirm-root-cause problemId 不存在返 404', async () => {
  await withIsolatedEnv(async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/onsite/problems/does-not-exist/confirm-root-cause')
      .send({
        root_cause_text: '干净的根因结论',
        reason: '足够长的 reason 字段',
      });
    assert.equal(res.status, 404);
  });
});
