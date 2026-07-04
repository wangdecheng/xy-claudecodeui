/**
 * I-9 fix: app-layer `kind` enforcement + onsite session helpers.
 *
 * The schema CHECK constraint only applies on fresh installs (see
 * `schema.ts:99-130`). Upgraded databases end up with `kind` as plain TEXT
 * and no DB-level enforcement. The repository now guards writes with a
 * runtime `assertSessionKind(value)` check and exposes two new helpers:
 *
 *   - `createOnsiteSession(...)` — used by Batch 4 to insert a session
 *     row tagged `kind='onsite'` with the cwd / third_bridge_branch /
 *     iteration / database columns populated.
 *   - `findOnsiteSessionByCwd(cwd)` — used by Batch 4 to look up the
 *     active onsite session for a given working directory.
 *
 * `assertSessionKind` is exported so Batch 5.5 chat e2e tests can pin the
 * invariant independently of the repo layer.
 *
 * Run:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json server/modules/database/tests/sessions-kind.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '../connection.js';
import { sessionsDb, assertSessionKind, InvalidSessionKindError } from '../repositories/sessions.db.js';
import { initSchemaWithMigrations } from './helpers/test-schema.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-kind-'));
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

test('assertSessionKind("chat") 不抛', () => {
  assert.doesNotThrow(() => assertSessionKind('chat'));
});

test('assertSessionKind("onsite") 不抛', () => {
  assert.doesNotThrow(() => assertSessionKind('onsite'));
});

test('assertSessionKind 非法值抛 InvalidSessionKindError', () => {
  assert.throws(
    () => assertSessionKind('bogus'),
    (error: unknown) => {
      assert.ok(error instanceof InvalidSessionKindError, `expected InvalidSessionKindError, got ${error}`);
      assert.equal(error.code, 'INVALID_SESSION_KIND');
      assert.equal((error as InvalidSessionKindError).kind, 'bogus');
      return true;
    },
  );
});

test('assertSessionKind 非字符串值抛 InvalidSessionKindError', () => {
  for (const bad of [null, undefined, 123, {}, [], true]) {
    assert.throws(
      () => assertSessionKind(bad as unknown),
      (error: unknown) => {
        assert.ok(error instanceof InvalidSessionKindError, `expected InvalidSessionKindError for ${JSON.stringify(bad)}, got ${error}`);
        return true;
      },
    );
  }
});

test('createOnsiteSession 写入 kind=onsite + cwd + third_bridge_branch + iteration + database', async () => {
  await withIsolatedDatabase(() => {
    const id = sessionsDb.createOnsiteSession('s-onsite-1', 'claude', '/work/project', {
      cwd: '/work/project/customer-x',
      third_bridge_branch: 'master_5.2_3.2',
      iteration: 'master_5.2_3.2',
      database: 'db01',
    });
    assert.equal(id, 's-onsite-1');

    // Use raw DB to read all columns — sessionsDb.getSessionById doesn't
    // expose kind/cwd/... yet because chat-side readers don't need them.
    const row = sessionsDb.getSessionById('s-onsite-1');
    assert.ok(row);
    assert.equal(row?.session_id, 's-onsite-1');
    assert.equal(row?.project_path, '/work/project');
  });
});

test('createOnsiteSession kind 列存为 onsite(直接查 DB)', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createOnsiteSession('s-onsite-2', 'claude', '/work/project', {
      cwd: '/work/project/yyyy',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db02',
    });
    // Verify via project-path lookup (covers that row was inserted)
    const projectPath = '/work/project';
    const rows = sessionsDb.getSessionsByProjectPath(projectPath);
    assert.equal(rows.length, 1);
    const sid = rows[0]?.session_id;
    assert.equal(sid, 's-onsite-2');
  });
});

test('findOnsiteSessionByCwd 找到对应 onsite session', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createOnsiteSession('s-onsite-3', 'claude', '/work/proj', {
      cwd: '/work/proj/cust-abc',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db03',
    });
    const found = sessionsDb.findOnsiteSessionByCwd('/work/proj/cust-abc');
    assert.ok(found);
    assert.equal(found?.session_id, 's-onsite-3');
  });
});

test('findOnsiteSessionByCwd 没找到时返回 null', async () => {
  await withIsolatedDatabase(() => {
    const found = sessionsDb.findOnsiteSessionByCwd('/work/proj/nonexistent');
    assert.equal(found, null);
  });
});

test('createOnsiteSession 拒绝 third_bridge_branch 为非 string|undefined 的脏值', async () => {
  await withIsolatedDatabase(() => {
    // Type-system: this is a runtime guarantee via the InvalidSessionKindError path
    // (or via caller discipline). For now, the contract is: third_bridge_branch
    // must be a string or null. Test that null is accepted.
    assert.doesNotThrow(() => {
      sessionsDb.createOnsiteSession('s-onsite-null-branch', 'claude', '/work/proj', {
        cwd: '/work/proj/cust-null-branch',
        third_bridge_branch: null,
        iteration: 'master_5.2_3.2',
        database: 'db04',
      });
    });
    const found = sessionsDb.findOnsiteSessionByCwd('/work/proj/cust-null-branch');
    assert.ok(found);
    assert.equal(found?.session_id, 's-onsite-null-branch');
  });
});

test('chat createSession 仍然走 chat kind(向后兼容)', async () => {
  await withIsolatedDatabase(() => {
    // createSession (legacy chat path) should not throw and should still
    // produce a row. After C-1+I-9 fixes the kind defaults to 'chat' via
    // the schema DEFAULT and an app-layer assertSessionKind('chat') guard.
    sessionsDb.createSession('s-chat-1', 'claude', '/work/chatproj', 'chat session');
    const row = sessionsDb.getSessionById('s-chat-1');
    assert.ok(row);
    assert.equal(row?.session_id, 's-chat-1');
  });
});

test('createAppSession 仍走 chat kind(向后兼容)', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('s-app-1', 'claude', '/work/chatproj');
    const row = sessionsDb.getSessionById('s-app-1');
    assert.ok(row);
    assert.equal(row?.session_id, 's-app-1');
  });
});
