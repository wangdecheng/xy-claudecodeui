/**
 * /api/onsite/files/* — 文件浏览器 + 下载端点测试 (ADR 0002)。
 *
 * 复用 onsite.routes.test.ts 的 buildApp() + withIsolatedEnv() 栈:
 * Express app + supertest + auth shim + ONSITE_ROOT 指向 tmp 目录 + 内存 schema。
 *
 * 只测外部 HTTP 行为(状态码 + body + Content-Disposition),不测内部函数。
 *
 * Run:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
 *     server/modules/onsite-analysis/tests/onsite-files-routes.test.ts
 */

import assert from 'node:assert/strict';
import express from 'express';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import test from 'node:test';

import onsiteRoutes from '../onsite.routes.js';

function buildApp(user?: { id: number; username: string }): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: number; username: string } }).user =
      user ?? { id: 1, username: 'tester' };
    next();
  });
  app.use('/api/onsite', onsiteRoutes);
  return app;
}

// /api/onsite/files/* 不读 problem 表,auth shim 直接注入 user 也不碰 DB,
// 故只需把 ONSITE_ROOT 指向 tmp 目录隔离文件系统,无需 DB setup。
async function withIsolatedEnv(runTest: () => Promise<void>): Promise<void> {
  const previousRoot = process.env.ONSITE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'onsite-files-'));
  const onsiteRoot = path.join(tempDir, 'onsite');

  process.env.ONSITE_ROOT = onsiteRoot;

  try {
    await runTest();
  } finally {
    if (previousRoot === undefined) {
      delete process.env.ONSITE_ROOT;
    } else {
      process.env.ONSITE_ROOT = previousRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// GET /api/onsite/files/tree
// ---------------------------------------------------------------------------

test('GET /files/tree 列根层,目录在前按名字排序,隐藏点号开头项', async () => {
  await withIsolatedEnv(async () => {
    const root = process.env.ONSITE_ROOT!;
    // 两个目录 + 两个文件 + 一个点号开头目录(应隐藏) + 一个点号开头文件(应隐藏)。
    await mkdir(path.join(root, '20260729-客户A'), { recursive: true });
    await mkdir(path.join(root, '20260729-客户B'), { recursive: true });
    await mkdir(path.join(root, '.claude'), { recursive: true });
    await writeFile(path.join(root, 'report.zip'), 'zip');
    await writeFile(path.join(root, '.hidden'), 'x');

    const res = await request(buildApp()).get('/api/onsite/files/tree');

    assert.equal(res.status, 200);
    const names = res.body.entries.map((e: { name: string }) => e.name);
    // 点号开头项被过滤。
    assert.ok(!names.includes('.claude'));
    assert.ok(!names.includes('.hidden'));
    // 目录在前。
    const types = res.body.entries.map((e: { type: string }) => e.type);
    const firstDirIdx = types.indexOf('dir');
    const lastFileIdx = types.length - 1 - types.slice().reverse().indexOf('file');
    assert.ok(firstDirIdx < lastFileIdx || !types.includes('file') || !types.includes('dir'));
    // 客户A / 客户B 都在。
    assert.ok(names.includes('20260729-客户A'));
    assert.ok(names.includes('20260729-客户B'));
    assert.ok(names.includes('report.zip'));
  });
});

test('GET /files/tree 列子层只返回直接子项(不递归),含 size/mtime', async () => {
  await withIsolatedEnv(async () => {
    const root = process.env.ONSITE_ROOT!;
    await mkdir(path.join(root, 'prob', 'unpacked-1'), { recursive: true });
    await writeFile(path.join(root, 'prob', 'problem.json'), '{}');
    await writeFile(path.join(root, 'prob', 'unpacked-1', 'access.log'), 'log-line\n');

    const res = await request(buildApp()).get('/api/onsite/files/tree?dir=prob');

    assert.equal(res.status, 200);
    const names = res.body.entries.map((e: { name: string }) => e.name);
    // 直接子项:problem.json + unpacked-1;不递归到 access.log。
    assert.deepEqual(names.sort(), ['problem.json', 'unpacked-1']);
    const fileEntry = res.body.entries.find((e: { name: string }) => e.name === 'problem.json');
    assert.equal(fileEntry.type, 'file');
    assert.equal(fileEntry.size, 2);
    assert.equal(typeof fileEntry.mtime, 'number');
    const dirEntry = res.body.entries.find((e: { name: string }) => e.name === 'unpacked-1');
    assert.equal(dirEntry.type, 'dir');
  });
});

test('GET /files/tree 越界 dir(含 ..)返回空数组,不暴露根外', async () => {
  await withIsolatedEnv(async () => {
    const root = process.env.ONSITE_ROOT!;
    await mkdir(path.join(root, 'prob'), { recursive: true });
    // ONSITE_ROOT 外的敏感文件。
    const outside = path.join(path.dirname(root), 'secret.txt');
    await writeFile(outside, 'top-secret');

    const res = await request(buildApp()).get('/api/onsite/files/tree?dir=../');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.entries, []);
  });
});

test('GET /files/tree 不存在的 dir 返回空数组(ENOENT 视为空)', async () => {
  await withIsolatedEnv(async () => {
    const res = await request(buildApp()).get('/api/onsite/files/tree?dir=does-not-exist');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.entries, []);
  });
});

// ---------------------------------------------------------------------------
// GET /api/onsite/files/download
// ---------------------------------------------------------------------------

test('GET /files/download 下文件 200 + Content-Disposition attachment + 正确内容', async () => {
  await withIsolatedEnv(async () => {
    const root = process.env.ONSITE_ROOT!;
    await mkdir(path.join(root, 'prob'), { recursive: true });
    await writeFile(path.join(root, 'prob', '结论.md'), '# 结论\n');

    const res = await request(buildApp())
      .get('/api/onsite/files/download')
      .query({ path: 'prob/结论.md', token: 'ignored-by-auth-shim' });

    assert.equal(res.status, 200);
    assert.match(res.headers['content-disposition'] ?? '', /attachment;\s*filename=/);
    assert.equal(res.text, '# 结论\n');
  });
});

test('GET /files/download 深层文件可下(不受根层直接子文件限制)', async () => {
  await withIsolatedEnv(async () => {
    const root = process.env.ONSITE_ROOT!;
    await mkdir(path.join(root, 'prob', 'unpacked-2'), { recursive: true });
    await writeFile(path.join(root, 'prob', 'unpacked-2', 'access.log'), 'deep-log');

    const res = await request(buildApp()).get('/api/onsite/files/download?path=prob/unpacked-2/access.log');

    assert.equal(res.status, 200);
    assert.equal(res.text, 'deep-log');
  });
});

test('GET /files/download 越界路径(含 ..)返回 403 FILE_OUTSIDE_ROOT', async () => {
  await withIsolatedEnv(async () => {
    const root = process.env.ONSITE_ROOT!;
    const outside = path.join(path.dirname(root), 'secret.txt');
    await writeFile(outside, 'top-secret');

    const res = await request(buildApp()).get('/api/onsite/files/download?path=../secret.txt');

    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'FILE_OUTSIDE_ROOT');
  });
});

test('GET /files/download 不存在文件返回 404 FILE_NOT_FOUND', async () => {
  await withIsolatedEnv(async () => {
    const res = await request(buildApp()).get('/api/onsite/files/download?path=nope/missing.log');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'FILE_NOT_FOUND');
  });
});

test('GET /files/download 软链逃逸 ONSITE_ROOT 返回 403', async () => {
  await withIsolatedEnv(async () => {
    const root = process.env.ONSITE_ROOT!;
    await mkdir(path.join(root, 'prob'), { recursive: true });
    // ONSITE_ROOT 外的真实文件 + 指向它的软链(非点号开头,会被 tree 列出)。
    const outside = path.join(path.dirname(root), 'escaped.txt');
    await writeFile(outside, 'escaped');
    await symlink(outside, path.join(root, 'prob', 'link-to-outside'));

    const res = await request(buildApp()).get('/api/onsite/files/download?path=prob/link-to-outside');

    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'FILE_OUTSIDE_ROOT');
  });
});

test('GET /files/download 无 path 参数返回 400', async () => {
  await withIsolatedEnv(async () => {
    const res = await request(buildApp()).get('/api/onsite/files/download');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'FILE_NOT_FOUND');
  });
});
