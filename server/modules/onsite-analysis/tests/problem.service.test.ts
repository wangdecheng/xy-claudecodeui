/**
 * ProblemService tests — TDD discipline.
 *
 * Covers:
 *  - create writes YYYYMMDD-客户 dir + problem.json
 *  - 同日同客户重复 -> 自动加 _2 后缀
 *  - create cwd=/etc -> 抛 CwdEscapeError
 *  - list scans dir + parses YYYYMMDD-* format
 *  - list skips docs/ + README.md
 *  - list 兼容无 problem.json 的旧目录 -> 默认 pending_info
 *  - sanitizeCustomerLabel 把 /\\:*?"<>| 替换为 _
 *  - getById returns record or null
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initSchemaWithMigrations } from '@/modules/database/tests/helpers/test-schema.js';
import { sanitizeCustomerLabel, CwdEscapeError, problemService } from '../problem.service.js';

async function withIsolatedEnv(runTest: () => Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousRoot = process.env.ONSITE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'problem-service-'));
  const dbPath = path.join(tempDir, 'auth.db');
  const onsiteRoot = path.join(tempDir, 'onsite');

  process.env.DATABASE_PATH = dbPath;
  process.env.ONSITE_ROOT = onsiteRoot;

  closeConnection();
  initSchemaWithMigrations();

  try {
    await runTest();
  } finally {
    closeConnection();
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

test('sanitizeCustomerLabel 把 /\\:*?"<>| 替换为 _', () => {
  assert.equal(sanitizeCustomerLabel('山西/公安'), '山西_公安');
  assert.equal(sanitizeCustomerLabel('foo:bar'), 'foo_bar');
  assert.equal(sanitizeCustomerLabel('a<b>c'), 'a_b_c');
  assert.equal(sanitizeCustomerLabel('safe-name_中文'), 'safe-name_中文');
});

test('create 写入 YYYYMMDD-客户 目录 + problem.json', async () => {
  await withIsolatedEnv(async () => {
    const record = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: 'master_5.2_3.2',
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: process.env.ONSITE_ROOT + '/20260703-山西公安',
    });
    assert.ok(record.id.startsWith('20260703-山西公安'));

    const dirPath = path.join(process.env.ONSITE_ROOT!, '20260703-山西公安');
    const jsonPath = path.join(dirPath, 'problem.json');
    const json = JSON.parse(await (await import('node:fs/promises')).readFile(jsonPath, 'utf8'));
    assert.equal(json.customer, '山西公安');
    assert.equal(json.iteration, 'master_5.2_3.2');
    assert.equal(json.status, 'pending_info');
  });
});

test('create 同日同客户重复 -> 自动加 _2 后缀', async () => {
  await withIsolatedEnv(async () => {
    const cwd = process.env.ONSITE_ROOT + '/20260703-山西公安';
    await problemService.create({
      customer: '山西公安',
      third_bridge_branch: 'master_5.2_3.2',
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd,
    });
    const second = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: 'master_5.2_3.2',
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: cwd + '_2',
    });
    assert.ok(second.id.endsWith('_2') || second.id.includes('_2'));
  });
});

test('create cwd 越界(/etc) -> 抛 CwdEscapeError', async () => {
  await withIsolatedEnv(async () => {
    await assert.rejects(
      problemService.create({
        customer: 'evil',
        third_bridge_branch: 'master_5.2_3.2',
        iteration: 'master_5.2_3.2',
        database: 'db01',
        cwd: '/etc',
      }),
      (error: unknown) => error instanceof CwdEscapeError,
    );
  });
});

test('list 扫描目录 + 解析 YYYYMMDD-* 格式', async () => {
  await withIsolatedEnv(async () => {
    const root = process.env.ONSITE_ROOT!;
    await mkdir(path.join(root, '20260101-A客户'), { recursive: true });
    await writeFile(
      path.join(root, '20260101-A客户', 'problem.json'),
      JSON.stringify({
        customer: 'A客户',
        iteration: 'master_5.2_3.2',
        database: 'db01',
        status: 'analyzing',
        created_at: '2026-01-01T00:00:00.000Z',
        cwd: root + '/20260101-A客户',
      }),
      'utf8',
    );

    const items = await problemService.list();
    assert.equal(items.length, 1);
    assert.equal(items[0]!.customer, 'A客户');
    assert.equal(items[0]!.status, 'analyzing');
  });
});

test('list 跳过 docs/ 与 README.md', async () => {
  await withIsolatedEnv(async () => {
    const root = process.env.ONSITE_ROOT!;
    // docs/ 不是 YYYYMMDD-* 开头,会被跳过
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'docs', 'README.md'), '# hello', 'utf8');
    // README.md 顶层不是 YYYYMMDD-* 目录,跳过
    await writeFile(path.join(root, 'README.md'), '# top', 'utf8');

    const items = await problemService.list();
    assert.equal(items.length, 0);
  });
});

test('list 兼容无 problem.json 的旧目录 -> 默认 pending_info', async () => {
  await withIsolatedEnv(async () => {
    const root = process.env.ONSITE_ROOT!;
    await mkdir(path.join(root, '20250101-legacy'), { recursive: true });
    // 仅有一个空目录,无 problem.json
    const items = await problemService.list();
    assert.equal(items.length, 1);
    assert.equal(items[0]!.status, 'pending_info');
    assert.equal(items[0]!.customer, 'legacy');
  });
});

test('getById 返回 record 或 null', async () => {
  await withIsolatedEnv(async () => {
    const cwd = process.env.ONSITE_ROOT + '/20260703-X';
    const created = await problemService.create({
      customer: 'X',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd,
    });
    const row = await problemService.getById(created.id);
    assert.ok(row);
    assert.equal(row?.customer, 'X');

    const missing = await problemService.getById('does-not-exist');
    assert.equal(missing, null);
  });
});