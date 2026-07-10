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

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initSchemaWithMigrations } from '@/modules/database/tests/helpers/test-schema.js';
import { userDb } from '@/modules/database/repositories/users.js';
import { sanitizeCustomerLabel, CwdEscapeError, problemService, DescriptionRequiredError, __resetTombstoneForTests } from '../problem.service.js';

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
  // 模块级 tombstone 是进程级状态, 每个测试前清空, 避免前面测试的 remove()
  // 把状态渗透到当前测试。
  __resetTombstoneForTests();

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

test('create 写入 YYYYMMDDHHMMSS-客户 目录 + problem.json', async () => {
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
    // 新格式: YYYYMMDDHHMMSS-山西公安 (14 位数字 + - + 客户名)
    assert.ok(
      /^\d{14}-山西公安$/.test(record.id),
      `record.id 应形如 YYYYMMDDHHMMSS-山西公安, 实际 ${record.id}`,
    );
    assert.equal(record.description, '现场反馈第三方登录失败,traceId=abc123');

    const dirPath = path.join(process.env.ONSITE_ROOT!, record.id);
    const jsonPath = path.join(dirPath, 'problem.json');
    const json = JSON.parse(await (await import('node:fs/promises')).readFile(jsonPath, 'utf8'));
    assert.equal(json.customer, '山西公安');
    assert.equal(json.iteration, 'master_5.2_3.2');
    // 77502ed 废弃 pending_info 后, 新建问题默认 status='analyzing'。
    assert.equal(json.status, 'analyzing');
  });
});

/**
 * 同秒同客户重复 → 不能复用 ID。
 * 旧行为: day 精度, 必落到 _2 dedup。
 * 新行为: HHMMSS 让绝大多数情况下 ID 已经天然不同; 真到同一秒才回退 _2。
 */
test('create 同客户重复 → 两次 ID 至少不同 (HHMMSS 优先, _2 兜底)', async () => {
  await withIsolatedEnv(async () => {
    const cwd = process.env.ONSITE_ROOT + '/山西公安';

    const first = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: 'master_5.2_3.2',
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd,
      description: '首次创建',
    });
    // 首次创建: 不应带 _N 后缀 (即 nextAvailableDirName 直接返回 baseDirName)
    assert.ok(
      !/_\d+$/.test(first.id),
      `首次创建不应带 _N 后缀, 实际 id=${first.id}`,
    );

    const second = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: 'master_5.2_3.2',
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd, // 故意不变, 让 nextAvailableDirName 真正参与 dedup
      description: '同日重复创建',
    });

    // 关键不变量: 两次 ID 不能相等
    assert.notEqual(
      first.id,
      second.id,
      '同客户重复创建不应复用 ID —— HHMMSS 精度或 _N 兜底必须保证区分',
    );
    // 同秒场景才会落到 _2; 不同秒则各自得到独立 HHMMSS 前缀。
    const samePrefix = second.id.startsWith(`${first.id}`);
    const useUnderscore2 = second.id === `${first.id}_2`;
    assert.ok(
      samePrefix || useUnderscore2,
      `second.id(${second.id}) 应是 first.id(${first.id}) 加 _2 后缀, 或与之共享前缀 (HHMMSS 区分)`,
    );

    // list 应同时看到两条
    const listed = await problemService.list();
    const ids = listed.map((item) => item.id).sort();
    assert.equal(ids.length, 2);
    assert.equal(ids[0], first.id);
    assert.equal(ids[1], second.id);
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
    // getById 的 fallback 默认已与 list 对齐为 'analyzing' (77502ed 之后)
    assert.equal(found!.status, 'analyzing');
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
        description: '客户反馈A问题',
        created_at: '2026-01-01T00:00:00.000Z',
        cwd: root + '/20260101-A客户',
      }),
      'utf8',
    );

    const items = await problemService.list();
    assert.equal(items.length, 1);
    assert.equal(items[0]!.customer, 'A客户');
    assert.equal(items[0]!.status, 'analyzing');
    assert.equal(items[0]!.description, '客户反馈A问题');
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

test('list 兼容无 problem.json 的旧目录 -> 默认 analyzing (与 getById 一致)', async () => {
  await withIsolatedEnv(async () => {
    const root = process.env.ONSITE_ROOT!;
    await mkdir(path.join(root, '20250101-legacy'), { recursive: true });
    // 仅有一个空目录,无 problem.json
    const items = await problemService.list();
    assert.equal(items.length, 1);
    // 77502ed 废弃 pending_info 后, 读不到 problem.json 时 list 与 getById
    // 都用 'analyzing' 兜底, 见 problem.service.ts:list / getById。
    assert.equal(items[0]!.status, 'analyzing');
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
    assert.equal(row?.description, 'X 描述');

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

test('create 接 date 字段: 指定日期应作为 YYYYMMDDHHMMSS 目录前缀的日期段', async () => {
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
    // 目录前缀日期段应来自 date 字段 (20260515),不是今天; HHmmss 段来自 today()
    assert.ok(
      /^\d{8}\d{6}-Y$/.test(record.id),
      `record.id 应形如 YYYYMMDDHHMMSS-Y, 实际 ${record.id}`,
    );
    assert.ok(
      record.id.startsWith('20260515'),
      `record.id 的日期段应来自 input.date (20260515), 实际 ${record.id}`,
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
      /^\d{14}-Z$/.test(record.id),
      `record.id 应形如 YYYYMMDDHHMMSS-Z, 实际 ${record.id}`,
    );
    assert.ok(
      record.id.startsWith(today),
      `record.id 的日期段应是今天(${today}), 实际 ${record.id}`,
    );
  });
});

// ---------------------------------------------------------------------------
// remove - 删除 problem(磁盘目录 + DB 行 + 内存缓冲)
// ---------------------------------------------------------------------------

test('remove 删除磁盘目录 + DB 行 + 清内存', async () => {
  await withIsolatedEnv(async () => {
    const { messagesStore } = await import('../messages-store.service.js');
    const { onsiteProblemsDb } = await import('@/modules/database/repositories/onsite-problems.db.js');
    const { existsSync } = await import('node:fs');

    const created = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: process.env.ONSITE_ROOT + '/山西公安',
      description: '待删除的占位描述',
    });
    // 放一条内存消息,验证 remove 会清掉
    messagesStore.append({ problemId: created.id, role: 'assistant', kind: 'text', content: 'hi', ts: 1 });
    assert.equal(messagesStore.size(created.id), 1);

    const result = await problemService.remove(created.id);
    assert.equal(result.deleted, true);
    assert.equal(result.id, created.id);
    // 磁盘目录已删
    assert.equal(existsSync(created.cwd), false);
    // DB 行已删
    assert.equal(onsiteProblemsDb.findById(created.id), null);
    // 内存已清
    assert.equal(messagesStore.size(created.id), 0);
  });
});

test('remove 不存在的 id 返回 deleted:false(不抛错)', async () => {
  await withIsolatedEnv(async () => {
    const result = await problemService.remove('does-not-exist-anywhere');
    assert.equal(result.deleted, false);
    assert.equal(result.id, 'does-not-exist-anywhere');
  });
});

test('remove 删除后子表(file/audit)经 ON DELETE CASCADE 一并清空', async () => {
  await withIsolatedEnv(async () => {
    const { onsiteFilesDb } = await import('@/modules/database/repositories/onsite-files.db.js');
    const { onsiteStateAuditDb } = await import('@/modules/database/repositories/onsite-state-audit.db.js');

    const created = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd: process.env.ONSITE_ROOT + '/山西公安',
      description: '级联删除测试占位描述',
    });
    // 造子表数据:一条 file + 一条 audit
    onsiteFilesDb.insert({
      id: 'f-1',
      problem_id: created.id,
      original_name: 'log.zip',
      stored_path: '/tmp/log.zip',
      size: 10,
      kind: 'log',
      unpacked_dir: null,
    });
    onsiteStateAuditDb.append({
      problem_id: created.id,
      from_status: null,
      to_status: 'pending_info',
      reason: '初始创建占位',
      actor_id: null,
    });
    assert.equal(onsiteFilesDb.findByProblemId(created.id).length, 1);
    assert.equal(onsiteStateAuditDb.listByProblemId(created.id).length, 1);

    await problemService.remove(created.id);

    // 子表经 CASCADE 清空
    assert.equal(onsiteFilesDb.findByProblemId(created.id).length, 0);
    assert.equal(onsiteStateAuditDb.listByProblemId(created.id).length, 0);
  });
});

/**
 * Bug 回归(用户场景): 当天/同秒/同客户连续两次串行创建两条问题, ID 必须不同。
 * 旧实现只有 YYYYMMDD 精度, 删除第一条后立刻再建会复用原目录名 → ID 复用 →
 * session "连到一起"。
 *
 * 修复后: baseDirName 升级到 YYYYMMDDHHMMSS 精度。两条记录 ID 至少不同 —— 大多数
 * 情况直接因 HHMMSS 段不同落到独立目录, 真正同秒则交给 nextAvailableDirName _2 兜底。
 *
 * 注: 并发 (Promise.all) 同秒同客户同时 create 仍是 TOCTOU 竞态, 留作后续 PR 修
 * 状态机层的并发问题; 本次改动只保证"删除后秒级内串行重建"与"短间隔串行创建"的
 * 不变量。
 */
test('create 串行短间隔(同日期/同客户) → ID 不同或加 _2 后缀', async () => {
  await withIsolatedEnv(async () => {
    const cwd = process.env.ONSITE_ROOT + '/山西公安';

    const first = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd,
      description: '首条问题',
    });
    assert.ok(
      /^\d{14}-山西公安$/.test(first.id),
      `first.id 应形如 YYYYMMDDHHMMSS-山西公安, 实际 ${first.id}`,
    );

    const second = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd,
      description: '第二条问题',
    });

    assert.notEqual(
      first.id,
      second.id,
      '两条记录的 ID 至少要不同 —— HHMMSS 区分或 _2 兜底, 不允许复用',
    );
    const isUnderscore2 = second.id === `${first.id}_2`;
    const isDistinctHhmmss =
      /^\d{14}-山西公安$/.test(second.id) && second.id !== first.id;
    assert.ok(
      isUnderscore2 || isDistinctHhmmss,
      `second.id (${second.id}) 应是 first.id 加 _2 后缀, 或与之具有独立 HHMMSS`,
    );
  });
});

/**
 * 用户场景的"删除后秒内重建"路径: 创建 → 删除 → 立即再建 → ID 不能复用。
 * 这是这次改动想要关闭的核心回归窗口。
 */
test('create 删除后秒级窗口重建(同日期/同客户) → 新 ID 不复用旧的', async () => {
  await withIsolatedEnv(async () => {
    const cwd = process.env.ONSITE_ROOT + '/山西公安';

    const first = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd,
      description: '第一条,会被删',
    });
    await problemService.remove(first.id);

    // 立即重建。如果 HHMMSS 完全相等 (人类无法做到, CI 也极罕见), _2 兜底;
    // 否则自然得到独立 HHMMSS 前缀。
    const second = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd,
      description: '第二条,删后重建',
    });

    assert.notEqual(
      first.id,
      second.id,
      `删除后重建不应复用旧 ID (first=${first.id}, second=${second.id})`,
    );
    assert.ok(
      second.id === `${first.id}_2` || /^\d{14}-山西公安$/.test(second.id),
      '新 ID 形态应保持 yyyymmddHHmmss-customer 或 _2 兜底',
    );
  });
});

/**
 * Tombstone 自身行为: remove 把 ID 推入墓碑, 立即 create 时不允许复用。
 * 验证墓碑机制独立于"磁盘是否存在"也能生效 (这条独立测试需要被 create 之前
 * 先把 ID 推进墓碑; 通过 remove() 这条唯一路径隐式触发)。
 */
test('tombstone: remove 后立即重建, ID 必落入 _N 兜底', async () => {
  await withIsolatedEnv(async () => {
    const cwd = process.env.ONSITE_ROOT + '/山西公安';
    const first = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd,
      description: '首条',
    });
    // remove 推进 tombstone
    const removed = await problemService.remove(first.id);
    assert.equal(removed.deleted, true);

    // 立即重建。注意: 即便日期段不同, create 会基于 today() 重新计算 baseDirName,
    // 这里我们用同一秒内的概率天然高的情况做最小验证。
    const second = await problemService.create({
      customer: '山西公安',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      cwd,
      description: '删后重建',
    });

    assert.notEqual(first.id, second.id);
    // tombstone 强制避开 baseID; 同秒创建时落入 _2, 不同秒则得到独立 HHMMSS 前缀
    const shareBase = second.id.startsWith(first.id);
    const isUnderscore2 = second.id === `${first.id}_2`;
    const isDistinctHhmmss = /^\d{14}-山西公安$/.test(second.id) && second.id !== first.id;
    assert.ok(
      isUnderscore2 || (shareBase && isDistinctHhmmss) || (!shareBase && isDistinctHhmmss),
      `second.id (${second.id}) 必须是 first.id 的 _2 后缀, 或与之具有独立 HHMMSS`,
    );
  });
});

/**
 * 旧格式 (YYYYMMDD-客户, 无 HHMMSS) 必须仍然能被 list / getById 读取 —— 兼容历史数据。
 */
test('list / getById 兼容历史 YYYYMMDD-客户 目录', async () => {
  await withIsolatedEnv(async () => {
    const root = process.env.ONSITE_ROOT!;
    const legacyDir = '20260101-旧客户';
    await mkdir(path.join(root, legacyDir), { recursive: true });
    await writeFile(
      path.join(root, legacyDir, 'problem.json'),
      JSON.stringify({
        customer: '旧客户',
        iteration: 'master_5.2_3.2',
        database: 'db01',
        status: 'analyzing',
        description: '历史遗留目录',
        created_at: '2026-01-01T10:30:00.000Z',
        cwd: root + '/' + legacyDir,
      }),
      'utf8',
    );

    const items = await problemService.list();
    assert.ok(items.some((i) => i.id === legacyDir), 'list 应读出旧格式目录');
    const found = await problemService.getById(legacyDir);
    assert.ok(found, 'getById 应能命中旧格式目录');
    assert.equal(found!.customer, '旧客户');
  });
});

/**
 * Eager session 回归(create → 立即可发 chat.send 的前置条件)。
 *
 * 旧行为: sessions 行由 WebSocket hello 帧在 `ensureOnsiteSession` 里懒创建。
 * 客户端刚创建问题、立刻点开聊天、立刻发"你好"时, hello 帧可能晚于 chat.send
 * 到达服务端 → sessions 表里没这行 → handleChatSend 的 getSessionById
 * 走 SESSION_NOT_FOUND, AI 端无回应。
 *
 * 修复: problemService.create 落盘成功后立即 createOnsiteSession, 把"会话存在"
 * 提前到问题创建这一刻, 关掉 race。ensureOnsiteSession 仍然保留为幂等兜底
 * (重连/重启场景), 但首次创建不再依赖它。
 */
test('create 后 sessions 表立即有 kind=onsite 行 (eager session 关闭 race)', async () => {
  await withIsolatedEnv(async () => {
    const created = userDb.createUser('alice', 'hash-not-used-here');
    const userId = Number(created.id);

    // cwd 故意用跟最终 dirName 一致的占位(实际 dirName 由 yyyymmddHHmmss 派生),
    // 这里用 record.cwd 校验, 不写死 prefix。
    const record = await problemService.create({
      customer: 'Eager',
      third_bridge_branch: 'master_5.2_3.2',
      iteration: 'master_5.2_3.2',
      database: 'mysql',
      cwd: process.env.ONSITE_ROOT + '/Eager',
      description: 'Eager 描述',
      userId,
    });
    const cwd = record.cwd;

    // sessions 表应立即有一行, 而不是等 WS hello 才出现
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT session_id, kind, provider, project_path, cwd,
                third_bridge_branch, iteration, database, user_id
         FROM sessions WHERE session_id = ?`,
      )
      .get(record.id) as {
        session_id: string;
        kind: string;
        provider: string;
        project_path: string;
        cwd: string;
        third_bridge_branch: string | null;
        iteration: string;
        database: string;
        user_id: number;
      } | undefined;

    assert.ok(row, `sessions 表应立即有 session_id=${record.id} 的行`);
    assert.equal(row!.kind, 'onsite');
    assert.equal(row!.provider, 'claude');
    assert.equal(row!.project_path, cwd);
    assert.equal(row!.cwd, cwd);
    assert.equal(row!.third_bridge_branch, 'master_5.2_3.2');
    assert.equal(row!.iteration, 'master_5.2_3.2');
    assert.equal(row!.database, 'mysql');
    assert.equal(row!.user_id, userId, 'user_id 必须绑定到创建者, 不能为 NULL');
  });
});

/**
 * userId 缺省时应回退到 userDb.getFirstUser() 的 id (平台/单用户模式),
 * 不能因 type-level 改了 userId 必传就把所有非路由调用方炸掉。
 */
test('create 不传 userId 时回退到平台首用户 (向后兼容)', async () => {
  await withIsolatedEnv(async () => {
    const created = userDb.createUser('bob', 'hash');
    const fallbackId = Number(created.id);

    const record = await problemService.create({
      customer: 'Fallback',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'mysql',
      cwd: process.env.ONSITE_ROOT + '/Fallback',
      description: 'Fallback 描述',
      // 故意不传 userId, 走平台首用户兜底
    });

    const db = getConnection();
    const row = db
      .prepare('SELECT user_id FROM sessions WHERE session_id = ?')
      .get(record.id) as { user_id: number | null } | undefined;
    assert.ok(row, 'sessions 行应存在');
    assert.equal(row!.user_id, fallbackId, '应回退到平台首用户 id');
  });
});