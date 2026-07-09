/**
 * OnsiteWebSocketService + chat-run-registry kind 字段 — TDD discipline.
 *
 * Covers:
 *  - validateOnsiteHelloFrame: 合法 frame
 *  - validateOnsiteHelloFrame: 缺/错 kind
 *  - validateOnsiteHelloFrame: problemId 缺失
 *  - validateOnsiteHelloFrame: cwd 越界(relative、escape root)
 *  - chatRunRegistry.startRun 默认 kind = 'chat'
 *  - chatRunRegistry.startRun 显式 kind = 'onsite' 写入
 *  - chatRunRegistry.getRunKind 返 chat/onsite/undefined
 *  - chatRunRegistry.startRun 重复 appSessionId 仍返 null(kind 字段不影响)
 *
 * Run:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
 *     server/modules/websocket/tests/onsite-websocket.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import {
  validateOnsiteHelloFrame,
  ONSITE_HELLO_KIND,
} from '@/modules/websocket/services/onsite-websocket.service.js';

class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];
  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedEnv(runTest: () => void | Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousRoot = process.env.ONSITE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'onsite-ws-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  process.env.ONSITE_ROOT = path.join(tempDir, 'onsite');
  closeConnection();
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    if (previousRoot === undefined) delete process.env.ONSITE_ROOT;
    else process.env.ONSITE_ROOT = previousRoot;
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// validateOnsiteHelloFrame — 纯函数测试
// ---------------------------------------------------------------------------

test('validateOnsiteHelloFrame: kind=onsite + 合法 problemId/cwd 返 ok', () => {
  const root = '/data/customer-onsite';
  const result = validateOnsiteHelloFrame(
    { kind: ONSITE_HELLO_KIND, problemId: '20260704-X', cwd: `${root}/20260704-X`, userId: 'u1' },
    root,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.payload.problemId, '20260704-X');
    assert.equal(result.payload.cwd, path.resolve(`${root}/20260704-X`));
    assert.equal(result.payload.userId, 'u1');
  }
});

test('validateOnsiteHelloFrame: 缺 kind 拒绝', () => {
  const root = '/data/customer-onsite';
  const result = validateOnsiteHelloFrame(
    { problemId: '20260704-X', cwd: `${root}/20260704-X` },
    root,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /kind/);
});

test('validateOnsiteHelloFrame: kind=chat 拒绝', () => {
  const root = '/data/customer-onsite';
  const result = validateOnsiteHelloFrame(
    { kind: 'chat', problemId: '20260704-X', cwd: `${root}/20260704-X` },
    root,
  );
  assert.equal(result.ok, false);
});

test('validateOnsiteHelloFrame: 非 object 拒绝', () => {
  const root = '/data/customer-onsite';
  const result = validateOnsiteHelloFrame('not-an-object', root);
  assert.equal(result.ok, false);
});

test('validateOnsiteHelloFrame: problemId 空拒绝', () => {
  const root = '/data/customer-onsite';
  const result = validateOnsiteHelloFrame(
    { kind: ONSITE_HELLO_KIND, problemId: '', cwd: `${root}/X` },
    root,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /problemId/);
});

test('validateOnsiteHelloFrame: cwd 越界 (escape root) 拒绝', () => {
  const root = '/data/customer-onsite';
  const result = validateOnsiteHelloFrame(
    { kind: ONSITE_HELLO_KIND, problemId: '20260704-X', cwd: '/etc/passwd' },
    root,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /cwd/);
});

test('validateOnsiteHelloFrame: cwd relative 路径会被拼到 root(合法)', () => {
  const root = '/data/customer-onsite';
  const result = validateOnsiteHelloFrame(
    { kind: ONSITE_HELLO_KIND, problemId: '20260704-X', cwd: '20260704-X' },
    root,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.payload.cwd, path.resolve(root, '20260704-X'));
  }
});

// ---------------------------------------------------------------------------
// chat-run-registry kind 字段
// ---------------------------------------------------------------------------

test('chatRunRegistry.startRun 默认 kind = chat', async () => {
  await withIsolatedEnv(() => {
    sessionsDb.createAppSession('app-kind-1', 'claude', '/workspace/demo', 1);
    chatRunRegistry.startRun({
      appSessionId: 'app-kind-1',
      provider: 'claude',
      providerSessionId: null,
      connection: new FakeConnection(),
      userId: 'user-1',
    });
    assert.equal(chatRunRegistry.getRunKind('app-kind-1'), 'chat');
  });
});

test('chatRunRegistry.startRun 显式 kind=onsite 写入', async () => {
  await withIsolatedEnv(() => {
    sessionsDb.createAppSession('app-kind-2', 'claude', '/workspace/demo', 1);
    chatRunRegistry.startRun({
      appSessionId: 'app-kind-2',
      provider: 'claude',
      providerSessionId: null,
      connection: new FakeConnection(),
      userId: 'user-1',
      kind: 'onsite',
    });
    assert.equal(chatRunRegistry.getRunKind('app-kind-2'), 'onsite');
  });
});

test('chatRunRegistry.getRunKind 未知 sessionId 返 undefined', () => {
  assert.equal(chatRunRegistry.getRunKind('not-existing'), undefined);
});

test('chatRunRegistry.startRun 重复 appSessionId(运行中) 返 null,不变 kind', async () => {
  await withIsolatedEnv(() => {
    sessionsDb.createAppSession('app-kind-dup', 'claude', '/workspace/demo', 1);
    const first = chatRunRegistry.startRun({
      appSessionId: 'app-kind-dup',
      provider: 'claude',
      providerSessionId: null,
      connection: new FakeConnection(),
      userId: 'u',
      kind: 'onsite',
    });
    assert.ok(first);
    const second = chatRunRegistry.startRun({
      appSessionId: 'app-kind-dup',
      provider: 'claude',
      providerSessionId: null,
      connection: new FakeConnection(),
      userId: 'u',
    });
    assert.equal(second, null);
    assert.equal(chatRunRegistry.getRunKind('app-kind-dup'), 'onsite');
  });
});