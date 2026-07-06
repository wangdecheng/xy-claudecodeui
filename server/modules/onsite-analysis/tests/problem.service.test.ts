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
import { sanitizeCustomerLabel, CwdEscapeError, problemService, DescriptionRequiredError } from '../problem.service.js';

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

/**
 * Compute today's YYYYMMDD in local time so tests don't break when the
 * calendar date rolls. Implementation derives the directory prefix from
 * `new Date()` (see problem.service.ts:formatYyyymmdd); tests must mirror
 * that, otherwise the assertion drifts one day later every 24 hours.
 */
function todayYyyymmdd(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

test('create 写入 YYYYMMDD-客户 目录 + problem.json', async () => {
  await withIsolatedEnv(async () => {
    const yyyymmdd = todayYyyymmdd();
    const record = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: 'master_5.2_3.2',
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: process.env.ONSITE_ROOT + `/${yyyymmdd}-山西公安`,
      description: '现场反馈第三方登录失败,traceId=abc123',
    });
    assert.ok(record.id.startsWith(`${yyyymmdd}-山西公安`));
    assert.equal(record.description, '现场反馈第三方登录失败,traceId=abc123');

    const dirPath = path.join(process.env.ONSITE_ROOT!, `${yyyymmdd}-山西公安`);
    const jsonPath = path.join(dirPath, 'problem.json');
    const json = JSON.parse(await (await import('node:fs/promises')).readFile(jsonPath, 'utf8'));
    assert.equal(json.customer, '山西公安');
    assert.equal(json.iteration, 'master_5.2_3.2');
    assert.equal(json.status, 'pending_info');
  });
});

test('create 同日同客户重复 -> 自动加 _2 后缀(走 nextAvailableDirName dedup 路径)', async () => {
  await withIsolatedEnv(async () => {
    const yyyymmdd = todayYyyymmdd();
    const cwd = process.env.ONSITE_ROOT + `/${yyyymmdd}-山西公安`;

    // 第一次创建:目录名应当是 base(没有 _2 后缀),即
    // `nextAvailableDirName` 返回的就是 baseDirName。
    const first = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: 'master_5.2_3.2',
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd,
      description: '首次创建',
    });
    assert.equal(
      first.id,
      `${yyyymmdd}-山西公安`,
      '首次创建应原样使用 base 目录名,不走 dedup 分支',
    );
    assert.equal(first.cwd, path.join(process.env.ONSITE_ROOT!, `${yyyymmdd}-山西公安`));

    // 第二次创建:故意传同样的 cwd(而不是预先加 _2 后缀),让
    // `nextAvailableDirName` 真正命中 dedup 循环,以确保该分支被
    // 覆盖。如果实现只用 cwd 的字面字符串就把 _2 拼回去,这条路径
    // 永远不会跑到。
    const second = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: 'master_5.2_3.2',
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd, // 故意不变,跟 first 完全一致
      description: '同日重复创建',
    });
    assert.equal(
      second.id,
      `${yyyymmdd}-山西公安_2`,
      '第二次创建应触发 dedup,_2 后缀由 nextAvailableDirName 分配',
    );
    assert.equal(
      second.cwd,
      path.join(process.env.ONSITE_ROOT!, `${yyyymmdd}-山西公安_2`),
      'dedup 后 record.cwd 也应指向新的 _2 目录,而不是 caller 传过来的 cwd',
    );

    // 两个目录都应当真实存在于磁盘上 —— 用 list 再把它们读出来确认
    // 两条记录都在 DB 行里。
    const listed = await problemService.list();
    const ids = listed.map((item) => item.id).sort();
    assert.deepEqual(
      ids,
      [`${yyyymmdd}-山西公安`, `${yyyymmdd}-山西公安_2`],
      'list 应同时返回首次和 dedup 后的两条记录',
    );
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
        description: 'evil',
      }),
      (error: unknown) => error instanceof CwdEscapeError,
    );
  });
});

test('getById 在 DB miss 但磁盘有目录时回退到磁盘扫描(兼容终端 agent 预建)', async () => {
  await withIsolatedEnv(async () => {
    const root = process.env.ONSITE_ROOT!;
    // 模拟终端 agent 提前建的目录,只有 session-context.json,没有 problem.json,DB 也没行
    const dir = path.join(root, '20260101-legacy-no-problem-json');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'session-context.json'), JSON.stringify({ traceId: 'abc' }), 'utf8');

    const found = await problemService.getById('20260101-legacy-no-problem-json');
    assert.ok(found, 'getById 应从磁盘回退返回该目录');
    assert.equal(found!.id, '20260101-legacy-no-problem-json');
    assert.equal(found!.customer, 'legacy-no-problem-json');
    assert.equal(found!.status, 'pending_info');
    assert.equal(found!.database, '');
    assert.equal(found!.problem_json_path, null);
    assert.equal(found!.cwd, dir);
  });
});

test('getById 在 DB miss 且磁盘无目录时返回 null', async () => {
  await withIsolatedEnv(async () => {
    const missing = await problemService.getById('does-not-exist-anywhere');
    assert.equal(missing, null);
  });
});

test('create description 为空字符串 -> 抛 DescriptionRequiredError', async () => {
  await withIsolatedEnv(async () => {
    const cwd = process.env.ONSITE_ROOT + '/20260101-X';
    await assert.rejects(
      () =>
        problemService.create({
          customer: 'X',
          third_bridge_branch: null,
          iteration: 'master_5.2_3.2',
          database: 'db01',
          cwd,
          description: '   ',
        }),
      (error: unknown) => error instanceof DescriptionRequiredError,
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
      description: 'X 描述',
    });
    const row = await problemService.getById(created.id);
    assert.ok(row);
    assert.equal(row?.customer, 'X');

    const missing = await problemService.getById('does-not-exist');
    assert.equal(missing, null);
  });
});

test('create 接 date 字段: 选了未来日期抛 400', async () => {
  await withIsolatedEnv(async () => {
    const future = new Date();
    future.setDate(future.getDate() + 7);
    const futureIso = future.toISOString().slice(0, 10);
    const cwd = process.env.ONSITE_ROOT + '/20260101-X';
    await assert.rejects(
      () =>
        problemService.create({
          customer: 'X',
          third_bridge_branch: null,
          iteration: 'master_5.2_3.2',
          database: 'db01',
          cwd,
          date: futureIso,
          description: 'X 描述',
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /问题日期不能晚于今天/);
        return true;
      },
    );
  });
});

test('create 接 date 字段: 指定日期应作为 YYYYMMDD 目录前缀', async () => {
  await withIsolatedEnv(async () => {
    const cwd = process.env.ONSITE_ROOT + '/20260515-Y';
    const record = await problemService.create({
      customer: 'Y',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd,
      date: '2026-05-15',
      description: 'Y 描述',
    });
    // 目录前缀应来自 date 字段,不是今天
    assert.ok(
      record.id.startsWith('20260515-'),
      `expected record.id to start with 20260515-, got ${record.id}`,
    );
  });
});

test('create 不接 date 字段时,默认用今天(向后兼容)', async () => {
  await withIsolatedEnv(async () => {
    const cwd = process.env.ONSITE_ROOT + '/X';
    const record = await problemService.create({
      customer: 'Z',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd,
      description: 'Z 描述',
    });
    const today = todayYyyymmdd();
    assert.ok(
      record.id.startsWith(`${today}-`),
      `expected record.id to start with ${today}-, got ${record.id}`,
    );
  });
});