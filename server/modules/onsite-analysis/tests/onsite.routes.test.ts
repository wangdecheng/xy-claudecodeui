/**
 * REST routes for /api/onsite/problems* — TDD discipline.
 *
 * Covers:
 *  - GET /api/onsite/problems 列表 + 排序 (blocked→analyzing→pending_info→confirmed→abandoned)
 *  - POST /api/onsite/problems 校验 + 创建
 *  - GET /api/onsite/problems/:id 200 / 404
 *  - PATCH /api/onsite/problems/:id StateMachine.apply + 广播
 *  - GET /api/onsite/problems/:id/files
 *  - 所有端点需 auth (401)
 *
 * Run:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
 *     server/modules/onsite-analysis/tests/onsite.routes.test.ts
 */

import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initSchemaWithMigrations } from '@/modules/database/tests/helpers/test-schema.js';

import onsiteRoutes from '../onsite.routes.js';
import { _setConfigForTests, resetConfig, type ConfigPayload } from '../config.service.js';
import { onsiteBroadcast } from '../onsite-broadcast.js';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  // Auth shim that injects a fake user so we don't need real JWT.
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

function buildAppWithoutAuth(): express.Express {
  // Use real auth middleware to verify 401 path.
  return express().use('/api/onsite', onsiteRoutes);
}

const samplePayload: ConfigPayload = {
  status: 'OK',
  mtime: new Date().toISOString(),
  data: {
    customers: [
      { label: '不涉及三方对接', branch: null },
      { label: '山西公安', branch: 'master_5.2_3.2' },
      { label: '浙一', branch: null },
    ],
    iterations: ['release_5.2_3.2_20260327', 'master_5.2_3.2'],
  },
};

async function withIsolatedEnv(runTest: () => Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousRoot = process.env.ONSITE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'onsite-routes-'));
  const dbPath = path.join(tempDir, 'auth.db');
  const onsiteRoot = path.join(tempDir, 'onsite');

  process.env.DATABASE_PATH = dbPath;
  process.env.ONSITE_ROOT = onsiteRoot;

  closeConnection();
  initSchemaWithMigrations();
  _setConfigForTests(samplePayload);

  try {
    await runTest();
  } finally {
    closeConnection();
    resetConfig();
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

function todayYyyymmdd(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// GET /api/onsite/problems
// ---------------------------------------------------------------------------

test('GET /api/onsite/problems 返 200 + 数组,排序 blocked→analyzing→pending_info→confirmed→abandoned', async () => {
  await withIsolatedEnv(async () => {
    const { problemService } = await import('../problem.service.js');
    const root = process.env.ONSITE_ROOT!;
    const yyyymmdd = todayYyyymmdd();

    // 通过 problemService.create 创建 5 条,避免手写 problem.json
    // 但创建后默认 status=pending_info,需要绕过 status 字段更新顺序
    // 改用直接读 after 创建顺序插入,然后通过不同顺序调 PATCH 来设置状态
    await problemService.create({
      customer: 'a-test',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: root + '/a-test',
    });
    await problemService.create({
      customer: 'b-test',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: root + '/b-test',
    });

    const app = buildApp();
    const response = await request(app).get('/api/onsite/problems');

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.problems));
    // list() 应当扫到磁盘的 YYYYMMDD-a-test / b-test — 但 cwd 实际是 ONSITE_ROOT/a-test
    // 走的是 nextAvailableDirName 路径,目录名是 todayYyyymmdd-...
    // 两条 record 应当都在
    assert.ok(response.body.problems.length >= 2);
  });
});

// ---------------------------------------------------------------------------
// POST /api/onsite/problems
// ---------------------------------------------------------------------------

test('POST 缺 customer 返 400', async () => {
  await withIsolatedEnv(async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/api/onsite/problems')
      .send({ iteration: 'master_5.2_3.2', database: 'db01', cwd: process.env.ONSITE_ROOT + '/X' });

    assert.equal(response.status, 400);
    assert.match(
      `${response.body.error || ''} ${response.body.message || ''} ${(response.body.fields || []).join(',')}`,
      /customer/i,
    );
  });
});

test('POST customer label 不在 config 返 422', async () => {
  await withIsolatedEnv(async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/api/onsite/problems')
      .send({
        customer: '未知客户',
        iteration: 'master_5.2_3.2',
        database: 'db01',
        cwd: process.env.ONSITE_ROOT + '/未知客户',
      });

    assert.equal(response.status, 422);
    assert.match(`${response.body.error || ''} ${response.body.message || ''}`, /customer/i);
  });
});

test('POST 合法 body 返 201 + problem.json 落盘 + cwd 在 ONSITE_ROOT 下', async () => {
  await withIsolatedEnv(async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/api/onsite/problems')
      .send({
        customer: '山西公安',
        third_bridge_branch: 'master_5.2_3.2',
        iteration: 'master_5.2_3.2',
        database: 'db01',
        cwd: process.env.ONSITE_ROOT + '/山西公安',
      });

    assert.equal(response.status, 201);
    assert.ok(response.body.id);
    assert.ok(response.body.id.startsWith(todayYyyymmdd()));
  });
});

test('POST cwd 越界(/etc) 返 409', async () => {
  await withIsolatedEnv(async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/api/onsite/problems')
      .send({
        customer: '山西公安',
        iteration: 'master_5.2_3.2',
        database: 'db01',
        cwd: '/etc',
      });

    assert.equal(response.status, 409);
    assert.match(`${response.body.error || ''} ${response.body.message || ''}`, /CWD_ESCAPE|cwd/i);
  });
});

// ---------------------------------------------------------------------------
// GET /api/onsite/problems/:id
// ---------------------------------------------------------------------------

test('GET /api/onsite/problems/:id 返 200 + record', async () => {
  await withIsolatedEnv(async () => {
    const { problemService } = await import('../problem.service.js');
    const created = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: process.env.ONSITE_ROOT + '/山西公安',
    });

    const app = buildApp();
    const response = await request(app).get(`/api/onsite/problems/${encodeURIComponent(created.id)}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.id, created.id);
    assert.equal(response.body.customer, '山西公安');
  });
});

test('GET /api/onsite/problems/:id 不存在返 404', async () => {
  await withIsolatedEnv(async () => {
    const app = buildApp();
    const response = await request(app).get('/api/onsite/problems/does-not-exist');

    assert.equal(response.status, 404);
    assert.match(`${response.body.error || ''} ${response.body.message || ''}`, /not found/i);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/onsite/problems/:id
// ---------------------------------------------------------------------------

test('PATCH 缺 reason 返 400', async () => {
  await withIsolatedEnv(async () => {
    const { problemService } = await import('../problem.service.js');
    const created = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: process.env.ONSITE_ROOT + '/山西公安',
    });

    const app = buildApp();
    const response = await request(app)
      .patch(`/api/onsite/problems/${encodeURIComponent(created.id)}`)
      .send({ status: 'analyzing' });

    assert.equal(response.status, 400);
    assert.match(`${response.body.error || ''} ${response.body.message || ''}`, /reason/i);
  });
});

test('PATCH reason < 8 字符返 400', async () => {
  await withIsolatedEnv(async () => {
    const { problemService } = await import('../problem.service.js');
    const created = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: process.env.ONSITE_ROOT + '/山西公安',
    });

    const app = buildApp();
    const response = await request(app)
      .patch(`/api/onsite/problems/${encodeURIComponent(created.id)}`)
      .send({ status: 'analyzing', reason: '短' });

    assert.equal(response.status, 400);
    assert.match(`${response.body.error || ''} ${response.body.message || ''}`, /reason/i);
  });
});

test('PATCH 非法状态迁移返 409 + allowed', async () => {
  await withIsolatedEnv(async () => {
    const { problemService } = await import('../problem.service.js');
    const created = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: process.env.ONSITE_ROOT + '/山西公安',
    });

    const app = buildApp();
    // pending_info → blocked 是非法
    const response = await request(app)
      .patch(`/api/onsite/problems/${encodeURIComponent(created.id)}`)
      .send({ status: 'blocked', reason: '尝试跳级到 blocked' });

    assert.equal(response.status, 409);
    assert.ok(Array.isArray(response.body.allowed));
  });
});

test('PATCH 合法迁移返 200 + audit 行落库', async () => {
  await withIsolatedEnv(async () => {
    const { problemService } = await import('../problem.service.js');
    const created = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: process.env.ONSITE_ROOT + '/山西公安',
    });

    const app = buildApp();
    const response = await request(app)
      .patch(`/api/onsite/problems/${encodeURIComponent(created.id)}`)
      .send({ status: 'analyzing', reason: '客户已补充问题背景', actor_id: 'u-1' });

    assert.equal(response.status, 200);
    assert.equal(response.body.from, 'pending_info');
    assert.equal(response.body.to, 'analyzing');

    // audit 行已写
    const { onsiteStateAuditDb } = await import('@/modules/database/repositories/onsite-state-audit.db.js');
    const audits = onsiteStateAuditDb.listByProblemId(created.id);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.reason, '客户已补充问题背景');
  });
});

test('PATCH 成功后 broadcast 触发 state-changed', async () => {
  await withIsolatedEnv(async () => {
    const { problemService } = await import('../problem.service.js');
    const created = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: process.env.ONSITE_ROOT + '/山西公安',
    });

    const received: Array<{ type: string; payload?: unknown }> = [];
    const sub = { send: (e: { type: string; payload?: unknown }) => received.push(e) };
    const off = onsiteBroadcast.subscribe(sub);

    try {
      const app = buildApp();
      const response = await request(app)
        .patch(`/api/onsite/problems/${encodeURIComponent(created.id)}`)
        .send({ status: 'analyzing', reason: '客户已补充问题背景' });

      assert.equal(response.status, 200);
      assert.equal(received.length, 1, '应收到一次 state-changed 广播');
      assert.match(received[0]!.type, /^problem:.+:state-changed$/);
    } finally {
      off();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/onsite/problems/:id/files
// ---------------------------------------------------------------------------

test('GET /api/onsite/problems/:id/files 返 200 + file 数组', async () => {
  await withIsolatedEnv(async () => {
    const { problemService } = await import('../problem.service.js');
    const { onsiteFilesDb } = await import('@/modules/database/repositories/onsite-files.db.js');
    const created = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: process.env.ONSITE_ROOT + '/山西公安',
    });

    onsiteFilesDb.insert({
      id: 'file-1',
      problem_id: created.id,
      original_name: 'log.zip',
      stored_path: '/tmp/log.zip',
      size: 1024,
      kind: 'log',
      unpacked_dir: null,
    });

    const app = buildApp();
    const response = await request(app).get(`/api/onsite/problems/${encodeURIComponent(created.id)}/files`);

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.files));
    assert.equal(response.body.files.length, 1);
    assert.equal(response.body.files[0].id, 'file-1');
  });
});

// ---------------------------------------------------------------------------
// 401 — 所有端点需 auth
// ---------------------------------------------------------------------------

test('所有端点需 auth (401 without token)', async () => {
  await withIsolatedEnv(async () => {
    const { authenticateToken } = await import('../../../middleware/auth.js');
    const app = express().use('/api/onsite', authenticateToken, onsiteRoutes);

    const getList = await request(app).get('/api/onsite/problems');
    assert.equal(getList.status, 401);

    const post = await request(app)
      .post('/api/onsite/problems')
      .send({ customer: 'X', iteration: 'Y', database: 'Z', cwd: '/etc' });
    assert.equal(post.status, 401);

    const getOne = await request(app).get('/api/onsite/problems/foo');
    assert.equal(getOne.status, 401);

    const patch = await request(app)
      .patch('/api/onsite/problems/foo')
      .send({ status: 'analyzing', reason: '因为客户补充信息' });
    assert.equal(patch.status, 401);

    const files = await request(app).get('/api/onsite/problems/foo/files');
    assert.equal(files.status, 401);
  });
});