/**
 * GET /api/onsite/problems/:id/messages — TDD for Batch 8 I1.
 *
 * Covers:
 *  - 200 + 数组(server 端 ring buffer)
 *  - 404 unknown id
 *  - 401 without token (mount point auth)
 *
 * Run:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
 *     server/modules/onsite-analysis/tests/onsite-messages-route.test.ts
 */

import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { userDb } from '@/modules/database/repositories/users.js';
import { initSchemaWithMigrations } from '@/modules/database/tests/helpers/test-schema.js';

import onsiteRoutes from '../onsite.routes.js';
import { _setConfigForTests, resetConfig, type ConfigPayload } from '../config.service.js';
import { messagesStore } from '../messages-store.service.js';

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

const samplePayload: ConfigPayload = {
  status: 'OK',
  mtime: new Date().toISOString(),
  data: {
    customers: [
      { label: '其他问题', branch: null },
      { label: '山西公安', branch: 'master_5.2_3.2' },
    ],
    iterations: ['release_5.2_3.2_20260327', 'master_5.2_3.2'],
  },
};

async function withIsolatedEnv(runTest: () => Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousRoot = process.env.ONSITE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'onsite-msg-route-'));
  const dbPath = path.join(tempDir, 'auth.db');
  const onsiteRoot = path.join(tempDir, 'onsite');

  process.env.DATABASE_PATH = dbPath;
  process.env.ONSITE_ROOT = onsiteRoot;

  closeConnection();
  initSchemaWithMigrations();
  userDb.createUser('tester', 'hash');
  _setConfigForTests(samplePayload);
  messagesStore._clearAllForTests();

  try {
    await runTest();
  } finally {
    closeConnection();
    resetConfig();
    messagesStore._clearAllForTests();
    if (previousDb === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDb;
    }
    if (previousRoot === undefined) {
      delete process.env.ONSITE_ROOT;
    } else {
      process.env.ONSITE_ROOT = previousRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('GET /api/onsite/problems/:id/messages 返 200 + 空数组(无消息)', async () => {
  await withIsolatedEnv(async () => {
    const { problemService } = await import('../problem.service.js');
    const created = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: process.env.ONSITE_ROOT! + '/山西公安',
      description: '测试用例占位描述',
    });

    const app = buildApp();
    const response = await request(app).get(
      `/api/onsite/problems/${encodeURIComponent(created.id)}/messages`,
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.problem_id, created.id);
    assert.ok(Array.isArray(response.body.messages));
    assert.equal(response.body.messages.length, 0);
  });
});

test('GET /api/onsite/problems/:id/messages 返 200 + 已写入的消息(正序)', async () => {
  await withIsolatedEnv(async () => {
    const { problemService } = await import('../problem.service.js');
    const created = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: process.env.ONSITE_ROOT! + '/山西公安',
      description: '测试用例占位描述',
    });

    // 手动 append 3 条(模拟 onsite WS 包 send 已写)
    messagesStore.append({
      problemId: created.id,
      role: 'user',
      kind: 'text',
      content: '第一条',
      ts: 1000,
    });
    messagesStore.append({
      problemId: created.id,
      role: 'assistant',
      kind: 'text',
      content: '第二条',
      ts: 1100,
    });
    messagesStore.append({
      problemId: created.id,
      role: 'assistant',
      kind: 'tool_use',
      content: '第三条',
      ts: 1200,
    });

    const app = buildApp();
    const response = await request(app).get(
      `/api/onsite/problems/${encodeURIComponent(created.id)}/messages`,
    );

    assert.equal(response.status, 200);
    const body = response.body as { problem_id: string; messages: Array<{ content: string; role: string; kind: string; ts: number }> };
    assert.equal(body.problem_id, created.id);
    assert.equal(body.messages.length, 3);
    assert.deepEqual(
      body.messages.map((m) => m.content),
      ['第一条', '第二条', '第三条'],
    );
    assert.deepEqual(
      body.messages.map((m) => m.role),
      ['user', 'assistant', 'assistant'],
    );
  });
});

test('GET /api/onsite/problems/:id/messages unknown id 返 404', async () => {
  await withIsolatedEnv(async () => {
    const app = buildApp();
    const response = await request(app).get('/api/onsite/problems/does-not-exist/messages');

    assert.equal(response.status, 404);
    assert.match(`${response.body.error} ${response.body.message}`, /not found/i);
  });
});

test('GET /api/onsite/problems/:id/messages 无 token 返 401', async () => {
  await withIsolatedEnv(async () => {
    const { authenticateToken } = await import('../../../middleware/auth.js');
    const app = express().use('/api/onsite', authenticateToken, onsiteRoutes);
    const response = await request(app).get('/api/onsite/problems/foo/messages');

    assert.equal(response.status, 401);
  });
});
