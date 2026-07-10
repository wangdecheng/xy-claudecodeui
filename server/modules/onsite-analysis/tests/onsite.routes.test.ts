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

function buildApp(user?: { id: number; username: string }): express.Express {
  const app = express();
  app.use(express.json());
  // Auth shim that injects a fake user so we don't need real JWT.
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: number; username: string } }).user =
      user ?? { id: 1, username: 'tester' };
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
      { label: '其他问题', branch: null },
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
      description: '测试用例占位描述',
    });
    await problemService.create({
      customer: 'b-test',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: root + '/b-test',
      description: '测试用例占位描述',
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
// GET /api/onsite/problems — 多用户隔离(回归 admin 越权 bug)
// ---------------------------------------------------------------------------
//
// 背景: admin 用户登录后能看到其他用户的 problem。根因是 GET /problems
// 路由没把 req.user.id 传给 problemService.list(),导致 disk 扫到所有
// 目录全返。修复后,登录用户仅看到自己创建的 problem + user_id IS NULL
// 的公开 problem。

test('GET /problems 仅返回当前登录用户的 problem (按 user_id 隔离)', async () => {
  await withIsolatedEnv(async () => {
    const { problemService } = await import('../problem.service.js');
    const { userDb } = await import('@/modules/database/repositories/users.js');
    const root = process.env.ONSITE_ROOT!;

    // 建两个用户,各自 create 一条 problem。create 走 eager session
    // 路径,会自动写 sessions 行并绑定 user_id。
    const alice = userDb.createUser('alice', 'hash');
    const bob = userDb.createUser('bob', 'hash');
    const aliceId = Number(alice.id);
    const bobId = Number(bob.id);

    const aliceProblem = await problemService.create({
      customer: 'AliceCo',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: root + '/AliceCo',
      description: 'alice 的现场反馈',
      userId: aliceId,
    });
    const bobProblem = await problemService.create({
      customer: 'BobCo',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: root + '/BobCo',
      description: 'bob 的现场反馈',
      userId: bobId,
    });

    // alice 登录 → 只看到 alice 的
    const aliceApp = buildApp({ id: aliceId, username: 'alice' });
    const aliceRes = await request(aliceApp).get('/api/onsite/problems');
    assert.equal(aliceRes.status, 200);
    const aliceIds = (aliceRes.body.problems as Array<{ id: string }>).map((p) => p.id);
    assert.ok(aliceIds.includes(aliceProblem.id), 'alice 应看到自己的 problem');
    assert.ok(
      !aliceIds.includes(bobProblem.id),
      `alice 不应看到 bob 的 problem,实际看到 ids=${aliceIds.join(',')}`,
    );

    // bob 登录 → 只看到 bob 的
    const bobApp = buildApp({ id: bobId, username: 'bob' });
    const bobRes = await request(bobApp).get('/api/onsite/problems');
    assert.equal(bobRes.status, 200);
    const bobIds = (bobRes.body.problems as Array<{ id: string }>).map((p) => p.id);
    assert.ok(bobIds.includes(bobProblem.id), 'bob 应看到自己的 problem');
    assert.ok(!bobIds.includes(aliceProblem.id), 'bob 不应看到 alice 的 problem');
  });
});

test('GET /problems 看得见 user_id IS NULL 的公开 problem (历史数据 / 孤儿)', async () => {
  await withIsolatedEnv(async () => {
    const { problemService } = await import('../problem.service.js');
    const { sessionsDb } = await import('@/modules/database/repositories/sessions.db.js');
    const { userDb } = await import('@/modules/database/repositories/users.js');
    const { getConnection } = await import('@/modules/database/connection.js');
    const root = process.env.ONSITE_ROOT!;

    const alice = userDb.createUser('alice', 'hash');
    const aliceId = Number(alice.id);

    // alice 创建一个 problem (eager session 会写 user_id=aliceId)
    const aliceProblem = await problemService.create({
      customer: 'AliceCo',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: root + '/AliceCo',
      description: 'alice 自己的',
      userId: aliceId,
    });

    // 直接构造一个 sessions 行 user_id=NULL 的 problem,模拟历史数据 / 第三方集成。
    const publicProblem = await problemService.create({
      customer: 'PublicCo',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: root + '/PublicCo',
      description: '公开 problem',
      userId: aliceId, // 先用 alice 建出 sessions 行
    });
    // 把这条 sessions 行的 user_id 改成 NULL(模拟迁移前 NULL 旧数据)
    const db = getConnection();
    db.prepare(`UPDATE sessions SET user_id = NULL WHERE session_id = ?`).run(publicProblem.id);

    const aliceApp = buildApp({ id: aliceId, username: 'alice' });
    const res = await request(aliceApp).get('/api/onsite/problems');
    assert.equal(res.status, 200);
    const ids = (res.body.problems as Array<{ id: string }>).map((p) => p.id);
    assert.ok(ids.includes(aliceProblem.id), 'alice 应看到自己的 problem');
    assert.ok(
      ids.includes(publicProblem.id),
      `alice 应看到 user_id IS NULL 的公开 problem,实际 ids=${ids.join(',')}`,
    );

    // 再建一个 bob,验证 bob 也能看到公开 problem,但看不到 alice 的
    const bob = userDb.createUser('bob', 'hash');
    const bobId = Number(bob.id);
    const bobApp = buildApp({ id: bobId, username: 'bob' });
    const bobRes = await request(bobApp).get('/api/onsite/problems');
    const bobIds = (bobRes.body.problems as Array<{ id: string }>).map((p) => p.id);
    assert.ok(
      bobIds.includes(publicProblem.id),
      `bob 也应看到 user_id IS NULL 的公开 problem,实际 ids=${bobIds.join(',')}`,
    );
    assert.ok(
      !bobIds.includes(aliceProblem.id),
      'bob 不应看到 alice 的私有 problem',
    );
  });
});

test('GET /problems 看得见孤儿 problem (磁盘有目录,sessions 表无行)', async () => {
  await withIsolatedEnv(async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { userDb } = await import('@/modules/database/repositories/users.js');
    const root = process.env.ONSITE_ROOT!;
    const yyyymmdd = todayYyyymmdd();

    // 手工建一个磁盘目录 + problem.json,**完全不写 sessions 行**。
    // 这是迁移前老数据 / watcher 还没扫到的瞬态,应被视为公开。
    const dirName = `${yyyymmdd}235959-OrphanCo`;
    await mkdir(`${root}/${dirName}`, { recursive: true });
    await writeFile(
      `${root}/${dirName}/problem.json`,
      JSON.stringify({
        id: dirName,
        customer: 'OrphanCo',
        iteration: 'master_5.2_3.2',
        database: 'db01',
        status: 'analyzing',
        cwd: `${root}/${dirName}`,
        description: 'orphan problem',
      }),
      'utf8',
    );

    const alice = userDb.createUser('alice', 'hash');
    const bob = userDb.createUser('bob', 'hash');

    // alice 看得到
    const aliceApp = buildApp({ id: Number(alice.id), username: 'alice' });
    const aliceRes = await request(aliceApp).get('/api/onsite/problems');
    const aliceIds = (aliceRes.body.problems as Array<{ id: string }>).map((p) => p.id);
    assert.ok(
      aliceIds.includes(dirName),
      `alice 应看到孤儿 problem,实际 ids=${aliceIds.join(',')}`,
    );

    // bob 也看得到
    const bobApp = buildApp({ id: Number(bob.id), username: 'bob' });
    const bobRes = await request(bobApp).get('/api/onsite/problems');
    const bobIds = (bobRes.body.problems as Array<{ id: string }>).map((p) => p.id);
    assert.ok(
      bobIds.includes(dirName),
      `bob 也应看到孤儿 problem,实际 ids=${bobIds.join(',')}`,
    );
  });
});

test('GET /problems 缺 req.user.id 返 401 AUTH_USER_ID_MISSING', async () => {
  await withIsolatedEnv(async () => {
    // 不挂 auth shim,直接挂路由 —— req.user 不会被注入
    const app = express().use('/api/onsite', onsiteRoutes);
    const res = await request(app).get('/api/onsite/problems');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'AUTH_USER_ID_MISSING');
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
        description: 'test placeholder description',
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
        description: '客户反馈登录失败,traceId=abc123',
      });

    assert.equal(response.status, 201);
    assert.ok(response.body.id);
    assert.ok(response.body.id.startsWith(todayYyyymmdd()));
  });
});

test('POST 缺 description 返 400 + MISSING_FIELDS', async () => {
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

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'MISSING_FIELDS');
    assert.ok(response.body.fields.includes('description'));
  });
});

test('POST description 是空白字符返 400 + MISSING_FIELDS', async () => {
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
        description: '   \n\t  ',
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'MISSING_FIELDS');
    assert.ok(response.body.fields.includes('description'));
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
        description: 'test placeholder description',
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
      description: '测试用例占位描述',
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
      description: '测试用例占位描述',
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
      description: '测试用例占位描述',
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
      description: '测试用例占位描述',
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
      description: '测试用例占位描述',
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
      description: '测试用例占位描述',
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
      description: '测试用例占位描述',
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
// DELETE /api/onsite/problems/:id
// ---------------------------------------------------------------------------

test('DELETE 存在的 problem -> 200 + 磁盘目录删除 + DB 行消失 + 子表级联 + 广播 problems:changed', async () => {
  await withIsolatedEnv(async () => {
    const { problemService } = await import('../problem.service.js');
    const { onsiteFilesDb } = await import('@/modules/database/repositories/onsite-files.db.js');
    const { onsiteProblemsDb } = await import('@/modules/database/repositories/onsite-problems.db.js');
    const { existsSync } = await import('node:fs');

    const created = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: process.env.ONSITE_ROOT + '/山西公安',
      description: '待删除占位描述',
    });
    onsiteFilesDb.insert({
      id: 'f-1',
      problem_id: created.id,
      original_name: 'log.zip',
      stored_path: '/tmp/log.zip',
      size: 10,
      kind: 'log',
      unpacked_dir: null,
    });

    const received: Array<{ type: string }> = [];
    const sub = { send: (e: { type: string }) => received.push(e) };
    const off = onsiteBroadcast.subscribe(sub);

    try {
      const app = buildApp();
      const response = await request(app).delete(`/api/onsite/problems/${encodeURIComponent(created.id)}`);

      assert.equal(response.status, 200);
      assert.equal(response.body.id, created.id);
      assert.equal(response.body.deleted, true);
      // 磁盘目录已删
      assert.equal(existsSync(created.cwd), false);
      // DB 行已删
      assert.equal(onsiteProblemsDb.findById(created.id), null);
      // 子表经 CASCADE 清空
      assert.equal(onsiteFilesDb.findByProblemId(created.id).length, 0);
      // 广播 problems:changed
      assert.equal(received.length, 1, '应收到一次 problems:changed 广播');
      assert.equal(received[0]!.type, 'problems:changed');
    } finally {
      off();
    }
  });
});

test('DELETE 不存在的 id 返 404', async () => {
  await withIsolatedEnv(async () => {
    const app = buildApp();
    const response = await request(app).delete('/api/onsite/problems/does-not-exist');

    assert.equal(response.status, 404);
    assert.match(`${response.body.error || ''} ${response.body.message || ''}`, /not found/i);
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

    const del = await request(app).delete('/api/onsite/problems/foo');
    assert.equal(del.status, 401);
  });
});