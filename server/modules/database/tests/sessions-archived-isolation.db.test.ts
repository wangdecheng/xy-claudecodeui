import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-archived-isolation-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

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
 * 直接写一行 user_id=NULL 的 session（绕过 createSession 的 userId 守卫），
 * 模拟"commit 7556c91 之前"产生的 NULL 公开行。用来验证
 * `getSessionsByProjectPathAndUserIdIncludingArchived` 的"NULL = 公开"语义。
 */
function insertLegacyNullUserIdSession(sessionId: string, projectPath: string, customName: string | null = null): void {
  // sessions.project_path 有 FK → projects.project_path,先建项目行再插 session。
  projectsDb.createProjectPath(projectPath);
  getConnection()
    .prepare(
      `INSERT INTO sessions
         (session_id, provider, provider_session_id, custom_name, project_path, jsonl_path,
          isArchived, created_at, updated_at, user_id)
       VALUES (?, 'claude', ?, ?, ?, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)`,
    )
    .run(sessionId, sessionId, customName, projectPath);
}

/**
 * 回归测试：`/api/projects/archived` 跨用户泄漏。
 *
 * 复现的 bug：`/api/projects/archived` 路由原本签名是 `_req`（未读 userId），
 * 直接调用 `getArchivedProjectsWithSessions()`——后者
 * `getSessionsByProjectPathIncludingArchived` 不带 userId 过滤，把所有用户的
 * 归档会话都返回。两个浏览器登录两个账号后，都看到对方的归档会话。
 *
 * 修复：DB 层加 `getSessionsByProjectPathAndUserIdIncludingArchived`，
 * service 层透传 userId，route 层 `readReqUserId(req)` 提取。
 * 保留 `user_id IS NULL` 公开语义，登录用户只能看到自己的 + 公开的。
 */
test('getSessionsByProjectPathAndUserIdIncludingArchived: logged-in user only sees own + NULL rows', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('s5-arch-1', 'claude', '/workspace/p', 5, undefined, undefined, undefined, null);
    sessionsDb.createSession('s5-active-1', 'claude', '/workspace/p', 5, undefined, undefined, undefined, null);
    sessionsDb.updateSessionIsArchived('s5-arch-1', true);
    sessionsDb.createSession('s6-arch-1', 'claude', '/workspace/p', 6, undefined, undefined, undefined, null);
    sessionsDb.createSession('s6-active-1', 'claude', '/workspace/p', 6, undefined, undefined, undefined, null);
    sessionsDb.updateSessionIsArchived('s6-arch-1', true);
    insertLegacyNullUserIdSession('s-legacy-active-1', '/workspace/p');
    insertLegacyNullUserIdSession('s-legacy-arch-1', '/workspace/p');
    sessionsDb.updateSessionIsArchived('s-legacy-arch-1', true);

    const userAFiveAll = sessionsDb.getSessionsByProjectPathAndUserIdIncludingArchived('/workspace/p', 5);
    assert.deepEqual(
      userAFiveAll.map((row) => row.session_id).sort(),
      ['s-legacy-active-1', 's-legacy-arch-1', 's5-active-1', 's5-arch-1'],
    );

    const userBSixAll = sessionsDb.getSessionsByProjectPathAndUserIdIncludingArchived('/workspace/p', 6);
    assert.deepEqual(
      userBSixAll.map((row) => row.session_id).sort(),
      ['s-legacy-active-1', 's-legacy-arch-1', 's6-active-1', 's6-arch-1'],
    );

    const legacyAll = sessionsDb.getSessionsByProjectPathAndUserIdIncludingArchived('/workspace/p', null);
    assert.equal(legacyAll.length, 6);
  });
});

test('getSessionsByProjectPathAndUserIdIncludingArchived: single-user mode sees all rows', async () => {
  await withIsolatedDatabase(() => {
    // 模拟"单用户模式 / 平台模式"下三行：两行 NULL 旧数据 + 一行带 userId=5。
    insertLegacyNullUserIdSession('s-1', '/workspace/p');
    insertLegacyNullUserIdSession('s-2', '/workspace/p');
    sessionsDb.createSession('s-3', 'claude', '/workspace/p', 5, undefined, undefined, undefined, null);
    sessionsDb.updateSessionIsArchived('s-2', true);
    sessionsDb.updateSessionIsArchived('s-3', true);

    const all = sessionsDb.getSessionsByProjectPathAndUserIdIncludingArchived('/workspace/p', null);
    assert.equal(all.length, 3);
  });
});
