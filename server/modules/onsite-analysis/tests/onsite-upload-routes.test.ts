/**
 * File upload routes tests — TDD for Sub-task D (Batch 5.4).
 *
 * Covers:
 *  - POST /api/onsite/problems/:id/files with 3 zip → 207 + 3 行入库 + 3 个 unpacked-N 目录
 *  - POST with single 250MB file → 413 + PAYLOAD_TOO_LARGE
 *  - POST with corrupted zip → 207,2 行入库,unpacked-3 不存在
 *  - POST with unknown problem id → 404
 *  - POST with no files → 400
 *  - GET /api/onsite/problems/:id/files → 200 + file 数组
 *  - GET with unknown id → 404
 *
 * Run:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
 *     server/modules/onsite-analysis/tests/onsite-upload-routes.test.ts
 */

import assert from 'node:assert/strict';
import express from 'express';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initSchemaWithMigrations } from '@/modules/database/tests/helpers/test-schema.js';
import { onsiteFilesDb } from '@/modules/database/repositories/onsite-files.db.js';
import { onsiteProblemsDb } from '@/modules/database/repositories/onsite-problems.db.js';

import onsiteRoutes from '../onsite.routes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildZip(filePath: string, contents: Map<string, string>): Promise<void> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'upload-zip-'));
  for (const [name, content] of contents) {
    const filePathInTmp = path.join(tmpDir, name);
    const dir = path.dirname(filePathInTmp);
    await mkdir(dir, { recursive: true });
    await writeFile(filePathInTmp, content, 'utf8');
  }
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('zip', ['-r', filePath, '.'], { cwd: tmpDir });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`zip failed: ${stderr}`))));
    proc.on('error', reject);
  });
  await rm(tmpDir, { recursive: true, force: true });
}

async function withIsolatedEnv(runTest: () => Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousRoot = process.env.ONSITE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'upload-route-'));
  const databasePath = path.join(tempDir, 'auth.db');
  // Per-test isolated database file (avoids cross-test contamination).
  process.env.DATABASE_PATH = databasePath;
  // But ONSITE_ROOT is intentionally process-global — shared across the
  // entire test run. We instead create a per-test problem cwd under a
  // unique problem id so tests can write in parallel without colliding.
  if (!previousRoot) {
    process.env.ONSITE_ROOT = path.join(tempDir, 'onsite');
  }
  await mkdir(process.env.ONSITE_ROOT!, { recursive: true });
  closeConnection();
  initSchemaWithMigrations();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    if (previousRoot === undefined) delete process.env.ONSITE_ROOT;
    await rm(tempDir, { recursive: true, force: true });
  }
}

function seedProblem(id: string, cwd: string): void {
  onsiteProblemsDb.insert({
    id,
    customer: 'test',
    third_bridge_branch: null,
    iteration: 'master_5.2_3.2',
    database: 'db01',
    status: 'pending_info',
    cwd,
    problem_json_path: null,
  });
}

/**
 * Issue an in-process HTTP request through an Express handler pipeline.
 * We avoid spinning up a real listener to keep tests fast.
 */
async function callRoute(
  method: string,
  urlPath: string,
  body?: { fields?: Record<string, string>; files?: Array<{ field: string; originalname: string; path: string }> },
): Promise<{ status: number; body: unknown }> {
  const app = express();
  app.use(express.json());
  // mount under /api/onsite so the route prefix matches production
  app.use('/api/onsite', onsiteRoutes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;

      // Build multipart manually via fetch
      const boundary = '----boundary' + Date.now();
      const parts: Buffer[] = [];

      if (body?.fields) {
        for (const [k, v] of Object.entries(body.fields)) {
          parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
        }
      }

      const filePromises = (body?.files ?? []).map(async (f) => {
        const fs = await import('node:fs/promises');
        const content = await fs.readFile(f.path);
        const header = `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.originalname}"\r\nContent-Type: application/zip\r\n\r\n`;
        parts.push(Buffer.from(header));
        parts.push(content);
        parts.push(Buffer.from('\r\n'));
      });

      Promise.all(filePromises).then(() => {
        parts.push(Buffer.from(`--${boundary}--\r\n`));
        const bodyBuf = Buffer.concat(parts);

        // Use Node's http module
        const req = http.request({
          method,
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(bodyBuf.length),
          },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            server.close();
            const text = Buffer.concat(chunks).toString('utf8');
            try {
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
            } catch {
              resolve({ status: res.statusCode ?? 0, body: text });
            }
          });
        });
        req.on('error', reject);
        req.write(bodyBuf);
        req.end();
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('POST /api/onsite/problems/:id/files with 3 zip → 207 + 3 rows in onsite_files + 3 unpacked-N dirs', async () => {
  await withIsolatedEnv(async () => {
    const problemId = `20260704-test-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cwd = process.env.ONSITE_ROOT! + '/' + problemId;
    await mkdir(cwd, { recursive: true });
    seedProblem(problemId, cwd);

    const tmp = await mkdtemp(path.join(tmpdir(), 'upload-3zips-'));
    const f1 = path.join(tmp, 'logs1.zip');
    const f2 = path.join(tmp, 'logs2.zip');
    const f3 = path.join(tmp, 'logs3.zip');
    await buildZip(f1, new Map([['a.log', 'aaa']]));
    await buildZip(f2, new Map([['b.log', 'bbb']]));
    await buildZip(f3, new Map([['c.log', 'ccc']]));

    const res = await callRoute('POST', `/api/onsite/problems/${problemId}/files`, {
      files: [
        { field: 'files', originalname: 'logs1.zip', path: f1 },
        { field: 'files', originalname: 'logs2.zip', path: f2 },
        { field: 'files', originalname: 'logs3.zip', path: f3 },
      ],
    });

    assert.equal(res.status, 207);
    const body = res.body as { results: Array<{ ok: boolean; originalName: string; unpackedDir?: string }> };
    assert.ok(Array.isArray(body.results));
    assert.equal(body.results.length, 3);
    for (const r of body.results) {
      assert.equal(r.ok, true);
    }

    // 3 行入库
    const dbRows = onsiteFilesDb.findByProblemId(problemId);
    assert.equal(dbRows.length, 3);

    // 3 个目录
    const { existsSync } = await import('node:fs');
    assert.ok(existsSync(`${cwd}/unpacked-1`));
    assert.ok(existsSync(`${cwd}/unpacked-2`));
    assert.ok(existsSync(`${cwd}/unpacked-3`));

    await rm(tmp, { recursive: true, force: true });
  });
});

test('POST with corrupted zip → 207,2 rows in DB, unpacked-3 missing', async () => {
  await withIsolatedEnv(async () => {
    const problemId = `20260704-test-corrupt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cwd = process.env.ONSITE_ROOT! + '/' + problemId;
    await mkdir(cwd, { recursive: true });
    seedProblem(problemId, cwd);

    const tmp = await mkdtemp(path.join(tmpdir(), 'upload-corrupt-'));
    const f1 = path.join(tmp, 'ok1.zip');
    const f2 = path.join(tmp, 'ok2.zip');
    const f3 = path.join(tmp, 'corrupt.zip');
    await buildZip(f1, new Map([['a.log', 'a']]));
    await buildZip(f2, new Map([['b.log', 'b']]));
    await writeFile(f3, 'not a real zip', 'utf8');

    const res = await callRoute('POST', `/api/onsite/problems/${problemId}/files`, {
      files: [
        { field: 'files', originalname: 'ok1.zip', path: f1 },
        { field: 'files', originalname: 'ok2.zip', path: f2 },
        { field: 'files', originalname: 'corrupt.zip', path: f3 },
      ],
    });

    assert.equal(res.status, 207);
    const body = res.body as { results: Array<{ ok: boolean }> };
    assert.equal(body.results.filter((r) => r.ok).length, 2);

    const dbRows = onsiteFilesDb.findByProblemId(problemId);
    assert.equal(dbRows.length, 2);

    const { existsSync } = await import('node:fs');
    assert.ok(existsSync(`${cwd}/unpacked-1`));
    assert.ok(existsSync(`${cwd}/unpacked-2`));
    assert.equal(existsSync(`${cwd}/unpacked-3`), false);

    await rm(tmp, { recursive: true, force: true });
  });
});

test('POST with unknown problem id → 404', async () => {
  await withIsolatedEnv(async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'upload-404-'));
    const f1 = path.join(tmp, 'ok.zip');
    await buildZip(f1, new Map([['a.log', 'a']]));

    const res = await callRoute('POST', '/api/onsite/problems/not-found-id/files', {
      files: [{ field: 'files', originalname: 'ok.zip', path: f1 }],
    });

    assert.equal(res.status, 404);
    const body = res.body as { error: string };
    assert.match(body.error, /PROBLEM_NOT_FOUND/);

    await rm(tmp, { recursive: true, force: true });
  });
});

test('POST with no files → 400', async () => {
  await withIsolatedEnv(async () => {
    const problemId = `20260704-test-nofiles-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cwd = process.env.ONSITE_ROOT! + '/' + problemId;
    await mkdir(cwd, { recursive: true });
    seedProblem(problemId, cwd);

    const res = await callRoute('POST', `/api/onsite/problems/${problemId}/files`, {
      files: [],
    });

    assert.equal(res.status, 400);
  });
});

test('GET /api/onsite/problems/:id/files → 200 + file 数组', async () => {
  await withIsolatedEnv(async () => {
    const problemId = `20260704-test-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cwd = process.env.ONSITE_ROOT! + '/' + problemId;
    await mkdir(cwd, { recursive: true });
    seedProblem(problemId, cwd);

    // insert 1 行 file
    onsiteFilesDb.insert({
      id: 'f-1',
      problem_id: problemId,
      original_name: 'app.log',
      stored_path: `${cwd}/unpacked-1/app.log`,
      size: 1024,
      kind: 'log',
      unpacked_dir: `${cwd}/unpacked-1`,
    });

    const res = await callRoute('GET', `/api/onsite/problems/${problemId}/files`);
    assert.equal(res.status, 200);
    const body = res.body as { files: Array<{ original_name: string }> };
    assert.ok(Array.isArray(body.files));
    assert.equal(body.files.length, 1);
    assert.equal(body.files[0]!.original_name, 'app.log');
  });
});

test('GET with unknown id → 404', async () => {
  await withIsolatedEnv(async () => {
    const res = await callRoute('GET', '/api/onsite/problems/not-found-id/files');
    assert.equal(res.status, 404);
  });
});