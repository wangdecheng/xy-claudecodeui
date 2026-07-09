/**
 * 回归测试：sessions 表 user_id 必传守卫。
 *
 * 复现的 bug：commit 7556c91 引入 user_id 列后，repository 三个 create 函数
 * （createSession / createAppSession / createOnsiteSession）把 userId 声明为
 * 可选参数，filesystem 同步器链路上 5 个 provider 实现也都只调
 * `sessionsDb.createSession(...)` 不传 userId。结果：所有由 watcher / 同步器
 * 写库的 session 行 user_id 都是 NULL，登录用户登录后看不到自己产生的历史
 * session（因为按 user_id 过滤时被排除了）。
 *
 * 修复方向：保留历史 NULL 行的"公开可见"语义（迁移前数据），但禁止 repository
 * 在创建新行时接受 null/undefined 的 userId。同步器链路上必须把 caller 解析
 * 出的 userId 一路传到 createSession。
 *
 * 这一组测试钉住"userId 必传"的契约，作为所有 caller 改造的回归网。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { initSchemaWithMigrations } from './helpers/test-schema.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-user-id-required-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  initSchemaWithMigrations();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * 读 sessions 表里某行的 user_id 原始值（绕开 repo 抽象），用于校验 COALESCE
 * 语义。COALESCE 是 SQL 层行为，repo 没有直接 read-only 助手暴露。
 */
function readUserIdRaw(sessionId: string): number | null {
  const db = getConnection();
  const row = db
    .prepare('SELECT user_id FROM sessions WHERE session_id = ?')
    .get(sessionId) as { user_id: number | null } | undefined;
  return row?.user_id ?? null;
}

// ---------------------------------------------------------------------------
// createSession: 新行 userId 必传；存量行 COALESCE 保留
// ---------------------------------------------------------------------------

test('createSession: 缺省 userId 时抛 InvalidSessionUserIdError', async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      // 测 runtime 守卫：缺省 userId 触发 InvalidSessionUserIdError
      () => (sessionsDb as any).createSession('s-no-user', 'claude', '/workspace/p'),
      (err: unknown) => err instanceof Error && /userId is required/i.test(err.message),
    );
  });
});

test('createSession: 显式传 null 时抛 InvalidSessionUserIdError', async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      // 用 any 绕过类型系统：测的就是 createSession 在收到非法 userId
      // (null/undefined) 时由 assertSessionUserId 抛错的 runtime 行为。
      () => (sessionsDb as any).createSession(
        's-null-user',
        'claude',
        '/workspace/p',
        null,
        undefined,
        undefined,
        undefined,
        null,
      ),
      (err: unknown) => err instanceof Error && /userId is required/i.test(err.message),
    );
  });
});

test('createSession: 显式传 undefined 时抛 InvalidSessionUserIdError', async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      // 同上：测 runtime 守卫,绕过类型。
      () => (sessionsDb as any).createSession(
        's-undef-user',
        'claude',
        '/workspace/p',
        undefined,
        undefined,
        undefined,
        undefined,
        null,
      ),
      (err: unknown) => err instanceof Error && /userId is required/i.test(err.message),
    );
  });
});

test('createSession: 传有效 userId 成功写入（非 NULL）', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession(
      's-with-user',
      'claude',
      '/workspace/p',
      7,
      undefined,
      undefined,
      undefined,
      null,
    );
    assert.equal(readUserIdRaw('s-with-user'), 7);
  });
});

test('createSession: 已有行时 userId=null 不覆盖已有 user_id（COALESCE 保留归属）', async () => {
  await withIsolatedDatabase(() => {
    // 第一次：归属用户 7
    sessionsDb.createSession(
      's-claim',
      'claude',
      '/workspace/p',
      7,
      undefined,
      undefined,
      undefined,
      null,
    );
    assert.equal(readUserIdRaw('s-claim'), 7);

    // 第二次：另一用户 8 在 watcher 路径下重新 upsert,不应把归属改成 8
    sessionsDb.createSession(
      's-claim',
      'claude',
      '/workspace/p',
      8,
      undefined,
      undefined,
      undefined,
      null,
    );
    assert.equal(readUserIdRaw('s-claim'), 7, '存量 user_id 必须保留,不允许被覆盖');
  });
});

// ---------------------------------------------------------------------------
// createAppSession: userId 必传
// ---------------------------------------------------------------------------

test('createAppSession: 缺省 userId 时抛 InvalidSessionUserIdError', async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      // 测 runtime 守卫：缺省 userId 触发 InvalidSessionUserIdError
      () => (sessionsDb as any).createAppSession('s-app-no-user', 'claude', '/workspace/p'),
      (err: unknown) => err instanceof Error && /userId is required/i.test(err.message),
    );
  });
});

test('createAppSession: 传有效 userId 成功写入', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('s-app-with-user', 'claude', '/workspace/p', 9);
    assert.equal(readUserIdRaw('s-app-with-user'), 9);
  });
});

// ---------------------------------------------------------------------------
// createOnsiteSession: userId 必传
// ---------------------------------------------------------------------------

test('createOnsiteSession: 缺省 userId 时抛 InvalidSessionUserIdError', async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      // 测 runtime 守卫：缺省 userId 触发 InvalidSessionUserIdError
      () => (sessionsDb as any).createOnsiteSession('s-onsite-no-user', 'claude', '/workspace/p', {
        cwd: '/workspace/p',
        third_bridge_branch: null,
        iteration: 'i1',
        database: 'd1',
        }),
      (err: unknown) => err instanceof Error && /userId is required/i.test(err.message),
    );
  });
});

test('createOnsiteSession: 传有效 userId 成功写入', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createOnsiteSession(
      's-onsite-with-user',
      'claude',
      '/workspace/p',
      {
        cwd: '/workspace/p',
        third_bridge_branch: null,
        iteration: 'i1',
        database: 'd1',
      },
      11,
    );
    assert.equal(readUserIdRaw('s-onsite-with-user'), 11);
  });
});
