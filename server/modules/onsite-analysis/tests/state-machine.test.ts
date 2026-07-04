/**
 * StateMachine service tests — TDD discipline.
 *
 * Covers (≥ 7 legal + 7 illegal + 4 apply error paths):
 *  - canTransition: 11 条合法边
 *  - canTransition: 7+ 条非法边
 *  - apply: reason < 8 字符抛 ReasonTooShortError
 *  - apply: 不存在 problemId 抛 ProblemNotFoundError
 *  - apply: 合法迁移更新 status + 写 audit + 同步 problem.json
 *  - apply: 非法迁移抛 InvalidStateTransitionError
 *  - apply: 事务原子性 (audit 行与 status 更新一起回滚)
 *
 * Run:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
 *     server/modules/onsite-analysis/tests/state-machine.test.ts
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initSchemaWithMigrations } from '@/modules/database/tests/helpers/test-schema.js';
import { onsiteProblemsDb } from '@/modules/database/repositories/onsite-problems.db.js';
import { onsiteStateAuditDb } from '@/modules/database/repositories/onsite-state-audit.db.js';

import {
  canTransition,
  apply,
  ReasonTooShortError,
  InvalidStateTransitionError,
  ProblemNotFoundError,
  type ProblemStatus,
} from '../state-machine.service.js';

async function withIsolatedEnv(runTest: () => Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousRoot = process.env.ONSITE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'state-machine-'));
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

function todayYyyymmdd(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 直接向 DB 插入一行 problem,绕开 ProblemService(避免 create 副作用)
 */
function seedProblem(
  id: string,
  cwd: string,
  status: ProblemStatus = 'pending_info',
  problemJsonPath: string | null = null,
): void {
  onsiteProblemsDb.insert({
    id,
    customer: id.split('-').slice(1).join('-') || 'X',
    third_bridge_branch: null,
    iteration: 'master_5.2_3.2',
    database: 'db01',
    status,
    cwd,
    problem_json_path: problemJsonPath,
  });
}

// ---------------------------------------------------------------------------
// canTransition — 合法边 (11 条)
// ---------------------------------------------------------------------------

const LEGAL_TRANSITIONS: Array<[ProblemStatus, ProblemStatus]> = [
  ['pending_info', 'analyzing'],
  ['analyzing', 'blocked'],
  ['analyzing', 'confirmed'],
  ['analyzing', 'pending_info'],
  ['blocked', 'analyzing'],
  ['confirmed', 'analyzing'],
  // 任意非 abandoned → abandoned
  ['pending_info', 'abandoned'],
  ['analyzing', 'abandoned'],
  ['blocked', 'abandoned'],
  ['confirmed', 'abandoned'],
];

for (const [from, to] of LEGAL_TRANSITIONS) {
  test(`合法迁移 ${from} → ${to}`, () => {
    const r = canTransition(from, to);
    assert.equal(r.ok, true, `expected ${from} → ${to} to be legal`);
  });
}

// ---------------------------------------------------------------------------
// canTransition — 非法边 (7+ 条)
// ---------------------------------------------------------------------------

const ILLEGAL_TRANSITIONS: Array<[ProblemStatus, ProblemStatus]> = [
  ['pending_info', 'blocked'], // 必须先 analyzing
  ['pending_info', 'confirmed'], // 必须先 analyzing
  ['abandoned', 'analyzing'], // 终态不可出
  ['abandoned', 'pending_info'], // 终态不可出 (额外覆盖)
  ['blocked', 'confirmed'], // 跳级
  ['confirmed', 'pending_info'], // 跳级
  ['pending_info', 'pending_info'], // 自环
  ['analyzing', 'analyzing'], // 自环
  ['blocked', 'blocked'], // 自环
  ['confirmed', 'confirmed'], // 自环
  ['abandoned', 'abandoned'], // 终态自环
];

for (const [from, to] of ILLEGAL_TRANSITIONS) {
  test(`非法迁移 ${from} → ${to} 返回 allowed 列表`, () => {
    const r = canTransition(from, to);
    assert.equal(r.ok, false, `expected ${from} → ${to} to be illegal`);
    if (!r.ok) {
      assert.ok(Array.isArray(r.allowed), 'allowed should be an array');
    }
  });
}

test('canTransition 非法时 allowed 列表反映真实允许的后继', () => {
  const r = canTransition('pending_info', 'blocked');
  assert.equal(r.ok, false);
  if (!r.ok) {
    // pending_info 的合法后继应当是 analyzing + abandoned
    assert.deepEqual([...r.allowed].sort(), ['abandoned', 'analyzing']);
  }
});

// ---------------------------------------------------------------------------
// apply — error paths (4)
// ---------------------------------------------------------------------------

test('apply reason trim 后 < 8 字符抛 ReasonTooShortError', async () => {
  await withIsolatedEnv(async () => {
    const id = `${todayYyyymmdd()}-X`;
    seedProblem(id, process.env.ONSITE_ROOT + '/' + id);

    await assert.rejects(
      apply(id, 'analyzing', '  short  ', null),
      (err: unknown) =>
        err instanceof ReasonTooShortError && (err as ReasonTooShortError).code === 'REASON_TOO_SHORT',
    );
  });
});

test('apply 不存在的 problemId 抛 ProblemNotFoundError', async () => {
  await withIsolatedEnv(async () => {
    await assert.rejects(
      apply('does-not-exist', 'analyzing', '因为客户要补充信息', null),
      (err: unknown) =>
        err instanceof ProblemNotFoundError && (err as ProblemNotFoundError).code === 'PROBLEM_NOT_FOUND',
    );
  });
});

test('apply 非法状态迁移抛 InvalidStateTransitionError 且包含 from/allowed', async () => {
  await withIsolatedEnv(async () => {
    const id = `${todayYyyymmdd()}-X`;
    seedProblem(id, process.env.ONSITE_ROOT + '/' + id, 'pending_info');

    await assert.rejects(
      apply(id, 'blocked', '尝试跳级到 blocked', null),
      (err: unknown) => {
        if (!(err instanceof InvalidStateTransitionError)) return false;
        assert.equal((err as InvalidStateTransitionError).from, 'pending_info');
        assert.equal((err as InvalidStateTransitionError).to, 'blocked');
        assert.ok(Array.isArray((err as InvalidStateTransitionError).allowed));
        assert.equal((err as InvalidStateTransitionError).code, 'INVALID_STATE_TRANSITION');
        return true;
      },
    );
  });
});

test('apply 事务原子性:audit append 中途抛错 → status 与 audit 行一起回滚', async () => {
  await withIsolatedEnv(async () => {
    const id = `${todayYyyymmdd()}-atomic-rollback`;
    const cwd = path.join(process.env.ONSITE_ROOT!, id);
    seedProblem(id, cwd, 'pending_info');

    // baseline
    assert.equal(onsiteProblemsDb.findById(id)?.status, 'pending_info');
    assert.equal(onsiteStateAuditDb.listByProblemId(id).length, 0);

    // Inject a fault into the audit repo so the inner transaction throws
    // AFTER `updateStatusOnly` has staged its UPDATE but BEFORE the COMMIT.
    // better-sqlite3 `db.transaction(fn)()` rolls back any partial writes when
    // the inner fn throws, so status must still be `pending_info` and audit
    // count must still be 0 after `apply` rejects.
    const originalAppend = onsiteStateAuditDb.append;
    let appendCalls = 0;
    onsiteStateAuditDb.append = (audit) => {
      appendCalls += 1;
      throw new Error('simulated mid-transaction failure');
    };

    try {
      await assert.rejects(
        apply(id, 'analyzing', '测试事务回滚 — 应整体回滚', 'test-user'),
        (err: unknown) => err instanceof Error && /simulated mid-transaction failure/.test(err.message),
      );
    } finally {
      onsiteStateAuditDb.append = originalAppend;
    }

    assert.equal(appendCalls, 1, 'audit.append 必须被调用一次(在事务内)');

    // Atomicity proof: 即使 updateStatusOnly 已经 stage 了 UPDATE,
    // audit 抛错触发 ROLLBACK,两条写都没落库。
    const afterStatus = onsiteProblemsDb.findById(id)?.status;
    assert.equal(afterStatus, 'pending_info', 'status 必须保持 pending_info(rollback)');

    const auditAfter = onsiteStateAuditDb.listByProblemId(id).length;
    assert.equal(auditAfter, 0, 'audit 行数必须仍为 0(rollback)');
  });
});

// ---------------------------------------------------------------------------
// apply — happy path (1)
// ---------------------------------------------------------------------------

test('apply 合法迁移:更新 status + 写 audit 行 + 同步 problem.json', async () => {
  await withIsolatedEnv(async () => {
    const yyyymmdd = todayYyyymmdd();
    const id = `${yyyymmdd}-山西公安`;
    const problemJsonPath = path.join(process.env.ONSITE_ROOT!, id, 'problem.json');

    // 预写 problem.json (status=pending_info)
    await mkdir(path.dirname(problemJsonPath), { recursive: true });
    await writeFile(
      problemJsonPath,
      JSON.stringify({ id, status: 'pending_info', customer: '山西公安' }, null, 2),
      'utf8',
    );

    seedProblem(id, process.env.ONSITE_ROOT + '/' + id, 'pending_info', problemJsonPath);

    const result = await apply(id, 'analyzing', '客户已补充问题背景信息', 'user-1');

    assert.equal(result.from, 'pending_info');
    assert.equal(result.to, 'analyzing');
    assert.ok(typeof result.at === 'string' && result.at.length > 0);

    // DB status 已更新
    const row = onsiteProblemsDb.findById(id);
    assert.equal(row?.status, 'analyzing');

    // audit 行已写
    const audits = onsiteStateAuditDb.listByProblemId(id);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.from_status, 'pending_info');
    assert.equal(audits[0]?.to_status, 'analyzing');
    assert.equal(audits[0]?.reason, '客户已补充问题背景信息');
    assert.equal(audits[0]?.actor_id, 'user-1');

    // problem.json status 已同步
    const json = JSON.parse(await readFile(problemJsonPath, 'utf8'));
    assert.equal(json.status, 'analyzing');
  });
});

// ---------------------------------------------------------------------------
// apply — actorId = null 也能跑通
// ---------------------------------------------------------------------------

test('apply actorId=null 时 audit 行 actor_id 为 null', async () => {
  await withIsolatedEnv(async () => {
    const id = `${todayYyyymmdd()}-systemactor`;
    seedProblem(id, process.env.ONSITE_ROOT + '/' + id, 'pending_info');

    const result = await apply(id, 'analyzing', '系统自动推进到 analyzing 状态', null);

    assert.equal(result.from, 'pending_info');
    assert.equal(result.to, 'analyzing');
    const audits = onsiteStateAuditDb.listByProblemId(id);
    assert.equal(audits[0]?.actor_id, null);
  });
});