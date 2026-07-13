/**
 * TDD ownership checks for /onsite/ws hello binding.
 *
 * Run after coverage confirmation:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
 *     server/modules/websocket/tests/onsite-websocket-ownership.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WebSocket, WebSocketServer } from 'ws';

import { closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { problemService } from '@/modules/onsite-analysis/problem.service.js';
import { onsiteWebSocketService } from '@/modules/websocket/services/onsite-websocket.service.js';

type Listener = (...args: unknown[]) => void;

class FakeWebSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  frames: Array<Record<string, unknown>> = [];
  closeCalls: Array<{ code: number; reason: string }> = [];
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code: number, reason: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.emit('close');
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  private removeListener(event: string, listener: Listener): void {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
    );
  }
}

function attachConnection(
  ws: FakeWebSocket,
  requestUser: { id: number; username: string },
): void {
  let connectionListener: Listener | undefined;
  const fakeWss = {
    on(event: string, listener: Listener) {
      if (event === 'connection') connectionListener = listener;
      return this;
    },
  };

  onsiteWebSocketService.attach(fakeWss as unknown as WebSocketServer);
  assert.ok(connectionListener, 'attach 必须注册 connection listener');
  connectionListener(
    ws as unknown as WebSocket,
    { url: '/onsite/ws', user: requestUser },
  );
}

async function withIsolatedEnv(
  runTest: (users: {
    alice: { id: number; username: string };
    bob: { id: number; username: string };
  }) => Promise<void>,
): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousRoot = process.env.ONSITE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'onsite-ws-owner-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  process.env.ONSITE_ROOT = path.join(tempDir, 'onsite');

  closeConnection();
  await initializeDatabase();
  const aliceRow = userDb.createUser('ws-owner-alice', 'hash');
  const bobRow = userDb.createUser('ws-other-bob', 'hash');
  const users = {
    alice: { id: Number(aliceRow.id), username: 'ws-owner-alice' },
    bob: { id: Number(bobRow.id), username: 'ws-other-bob' },
  };

  try {
    await runTest(users);
  } finally {
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    if (previousRoot === undefined) delete process.env.ONSITE_ROOT;
    else process.env.ONSITE_ROOT = previousRoot;
    await rm(tempDir, { recursive: true, force: true });
  }
}

test('非 owner 即使在 hello 伪造 owner userId 也被 4003 拒绝', async () => {
  await withIsolatedEnv(async ({ alice, bob }) => {
    const problem = await problemService.create({
      customer: 'WsOwnerCo',
      third_bridge_branch: null,
      iteration: 'release-test',
      database: 'mysql',
      cwd: `${process.env.ONSITE_ROOT}/WsOwnerCo`,
      description: 'WebSocket owner isolation test',
      userId: alice.id,
    });
    const ws = new FakeWebSocket();
    attachConnection(ws, bob);

    ws.emit(
      'message',
      Buffer.from(JSON.stringify({
        kind: 'onsite',
        problemId: problem.id,
        cwd: problem.cwd,
        userId: String(alice.id),
      })),
    );

    assert.equal(ws.closeCalls[0]?.code, 4003);
    assert.ok(
      ws.frames.some((frame) => frame.code === 'PROBLEM_FORBIDDEN'),
      '必须先发送不含资源详情的 PROBLEM_FORBIDDEN protocol_error',
    );
  });
});

test('owner 的 hello 若 problemId 与 cwd 不匹配则拒绝绑定上下文', async () => {
  await withIsolatedEnv(async ({ alice }) => {
    const problem = await problemService.create({
      customer: 'WsCwdCo',
      third_bridge_branch: null,
      iteration: 'release-test',
      database: 'mysql',
      cwd: `${process.env.ONSITE_ROOT}/WsCwdCo`,
      description: 'WebSocket cwd binding test',
      userId: alice.id,
    });
    const ws = new FakeWebSocket();
    attachConnection(ws, alice);

    ws.emit(
      'message',
      Buffer.from(JSON.stringify({
        kind: 'onsite',
        problemId: problem.id,
        cwd: `${process.env.ONSITE_ROOT}/another-problem`,
      })),
    );

    assert.ok(ws.closeCalls.length > 0, 'cwd 与 problem 记录不一致时必须关闭连接');
    assert.ok(
      ws.frames.some((frame) => frame.code === 'PROBLEM_CONTEXT_MISMATCH'),
      '必须返回上下文不匹配协议错误',
    );
  });
});

test('owner 身份来自 request.user，hello 省略 userId 仍可绑定且不改变 session owner', async () => {
  await withIsolatedEnv(async ({ alice }) => {
    const problem = await problemService.create({
      customer: 'WsHappyCo',
      third_bridge_branch: null,
      iteration: 'release-test',
      database: 'mysql',
      cwd: `${process.env.ONSITE_ROOT}/WsHappyCo`,
      description: 'WebSocket authenticated identity test',
      userId: alice.id,
    });
    const ws = new FakeWebSocket();
    attachConnection(ws, alice);

    ws.emit(
      'message',
      Buffer.from(JSON.stringify({
        kind: 'onsite',
        problemId: problem.id,
        cwd: problem.cwd,
      })),
    );

    assert.equal(ws.closeCalls.length, 0);
    const onsiteContext = (ws as FakeWebSocket & { onsite?: Record<string, unknown> }).onsite;
    assert.ok(onsiteContext, '授权成功后必须绑定 onsite context');
    assert.equal(
      'userId' in onsiteContext,
      false,
      'onsite context 的身份来自 request.user，不保留客户端 hello userId',
    );
    const session = sessionsDb.findOnsiteSessionByCwd(problem.cwd);
    assert.equal(session?.user_id, alice.id);
  });
});
