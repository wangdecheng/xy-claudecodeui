/**
 * discipline-write-protection.middleware — TDD discipline (4.5)。
 *
 * Covers:
 *  - detect("rm foo.log") 命中
 *  - detect("echo x > foo.log") 命中(> 写动作)
 *  - detect("sed -i s/x/y/ foo.log") 命中
 *  - detect("tee foo.log < /dev/null") 命中
 *  - detect("cat foo.log") 不命中(只读)
 *  - detect("echo x > notes.md") 不命中(非原日志路径)
 *  - detect("ls -la") 不命中(无写动作)
 *  - 命中落 discipline_log(kind=write_protection)
 *  - 命中不调 StateMachine.apply
 *  - chat 路径 enabledFor=false → 不挂(消息原样透传)
 *  - stdout_preview 截前 200 字
 *
 * Run:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
 *     server/modules/onsite-analysis/tests/discipline-write-protection.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WebSocket } from 'ws';

import { closeConnection } from '@/modules/database/connection.js';
import { onsiteDisciplineLogDb } from '@/modules/database/repositories/onsite-discipline-log.db.js';
import { onsiteProblemsDb } from '@/modules/database/repositories/onsite-problems.db.js';
import { initSchemaWithMigrations } from '@/modules/database/tests/helpers/test-schema.js';

import { disciplineWriteProtectionMiddleware } from '../discipline/discipline-write-protection.middleware.js';

class FakeWs {
  readyState = 1;
  kind: 'chat' | 'onsite' | undefined = undefined;
  sentFrames: string[] = [];
  send(data: string): void {
    this.sentFrames.push(data);
  }
}

async function withIsolatedEnv(runTest: () => void | Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousRoot = process.env.ONSITE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'wprot-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  process.env.ONSITE_ROOT = path.join(tempDir, 'onsite');
  closeConnection();
  initSchemaWithMigrations();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    if (previousRoot === undefined) delete process.env.ONSITE_ROOT;
    else process.env.ONSITE_ROOT = previousRoot;
    await rm(tempDir, { recursive: true, force: true });
  }
}

function seedProblem(id: string): void {
  onsiteProblemsDb.insert({
    id,
    customer: 'test',
    third_bridge_branch: null,
    iteration: 'master_5.2_3.2',
    database: 'db01',
    status: 'analyzing',
    cwd: '/tmp/cwd',
    problem_json_path: null,
  });
}

function makeCtx(opts: { problemId?: string; applyBlocked?: (id: string, reason: string) => Promise<void> } = {}) {
  const problemId = opts.problemId ?? '20260704-test';
  const applied: Array<{ id: string; reason: string }> = [];
  const applyBlocked = opts.applyBlocked ?? (async (id: string, reason: string) => {
    applied.push({ id, reason });
  });
  const logEntries: unknown[] = [];
  const logHit = (entry: unknown): void => {
    logEntries.push(entry);
    const e = entry as { problemId: string; kind: string; word?: string; position?: number; cmd?: string; stdout_preview?: string };
    try {
      onsiteDisciplineLogDb.append({
        problem_id: e.problemId,
        message_id: null,
        kind: e.kind,
        word: e.word ?? null,
        position: e.position ?? null,
        cmd: e.cmd ?? null,
        stdout_preview: e.stdout_preview ?? null,
      });
    } catch { /* ignore */ }
  };

  return { ctx: { enabledFor: (ws: WebSocket): boolean => (ws as unknown as { kind?: string }).kind === 'onsite', logHit, applyBlocked, problemId }, applied, logEntries };
}

// ---------------------------------------------------------------------------
// detect 纯函数测试
// ---------------------------------------------------------------------------

test('detect:rm foo.log 命中', () => {
  const r = disciplineWriteProtectionMiddleware.detect('rm foo.log');
  assert.equal(r.hit, true);
});

test('detect:echo x > foo.log 命中(> 写动作)', () => {
  const r = disciplineWriteProtectionMiddleware.detect('echo x > foo.log');
  assert.equal(r.hit, true);
});

test('detect:sed -i s/x/y/ foo.log 命中', () => {
  const r = disciplineWriteProtectionMiddleware.detect('sed -i s/x/y/ foo.log');
  assert.equal(r.hit, true);
});

test('detect:tee foo.log < /dev/null 命中', () => {
  const r = disciplineWriteProtectionMiddleware.detect('tee foo.log < /dev/null');
  assert.equal(r.hit, true);
});

test('detect:cat foo.log 不命中(只读)', () => {
  const r = disciplineWriteProtectionMiddleware.detect('cat foo.log');
  assert.equal(r.hit, false);
});

test('detect:echo x > notes.md 不命中(非原日志路径)', () => {
  const r = disciplineWriteProtectionMiddleware.detect('echo x > notes.md');
  assert.equal(r.hit, false);
});

test('detect:ls -la 不命中(无写动作)', () => {
  const r = disciplineWriteProtectionMiddleware.detect('ls -la');
  assert.equal(r.hit, false);
});

test('detect:rm -rf unpacked-1 命中(unpacked-N 也是受保护路径)', () => {
  const r = disciplineWriteProtectionMiddleware.detect('rm -rf unpacked-1');
  assert.equal(r.hit, true);
});

test('detect:cp -f x.jsonl y.jsonl 命中', () => {
  const r = disciplineWriteProtectionMiddleware.detect('cp -f src.jsonl dst.jsonl');
  assert.equal(r.hit, true);
});

// ---------------------------------------------------------------------------
// attachToWs — 集成
// ---------------------------------------------------------------------------

test('attachToWs: 命中落 discipline_log(kind=write_protection)', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const { ctx, logEntries } = makeCtx();
    disciplineWriteProtectionMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: 'rm foo.log',
      stdout: '',
    }));

    assert.ok(logEntries.some((e) => (e as { kind?: string }).kind === 'write_protection'));
    assert.equal(onsiteDisciplineLogDb.countByProblemId('20260704-test'), 1);
  });
});

test('attachToWs: 命中不调 StateMachine.apply', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const { ctx, applied } = makeCtx();
    disciplineWriteProtectionMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: 'echo x > foo.log',
      stdout: '',
    }));

    assert.equal(applied.length, 0, 'write-protection 是软审计,不调 applyBlocked');
  });
});

test('attachToWs: chat 路径 enabledFor=false → 不挂(消息原样透传)', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'chat';
    const { ctx, logEntries } = makeCtx();
    disciplineWriteProtectionMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: 'rm foo.log',
      stdout: '',
    }));

    assert.equal(logEntries.length, 0, 'chat 不应触发');
  });
});

test('attachToWs: stdout_preview 截前 200 字', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    let captured: { cmd?: string; stdout_preview?: string } | null = null;
    const logHit = (entry: { cmd?: string; stdout_preview?: string }) => {
      captured = entry;
    };
    disciplineWriteProtectionMiddleware.attachToWs(ws as unknown as WebSocket, {
      enabledFor: () => true,
      logHit,
      applyBlocked: async () => undefined,
      problemId: '20260704-test',
    });

    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: 'rm foo.log',
      stdout: 'x'.repeat(500),
    }));

    assert.ok(captured);
    assert.equal(captured!.cmd, 'rm foo.log');
    assert.ok((captured!.stdout_preview ?? '').length <= 200);
  });
});

test('attachToWs: 命中 envelope 加 discipline.writeOriginalLog flag', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const { ctx } = makeCtx();
    disciplineWriteProtectionMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: 'rm foo.log',
      stdout: '',
    }));

    const flagged = ws.sentFrames.find((f) => f.includes('"writeOriginalLog":true'));
    assert.ok(flagged, 'envelope 应带 writeOriginalLog flag');
  });
});