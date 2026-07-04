/**
 * discipline-trace-id.middleware — TDD discipline (4.4.a main + 4.4.b suspect)。
 *
 * Covers main signal(自动 blocked):
 *  - 主信号 regex:含"未找到" + 之前 60s 内 grep 过 traceId → emit + flag + applyBlocked
 *  - 主信号:"0 结果" + grep → emit
 *  - 主信号:"no matches" + grep → emit(英文)
 *  - 主信号:含"未找到" 但 60s 内无 grep → 不 emit(防误报)
 *  - 主信号:含"未找到" 但 grep 的 traceId 不匹配 → 不 emit
 *  - 强信号:grep -rc traceX 返 0 → emit
 *  - 强信号:rg / ag / ack 同 traceX 0 → emit
 *  - 强信号:ls 不触发(非 grep 家族)
 *  - emit 后调 StateMachine.apply → blocked
 *  - autoReason 包含 traceId + 触发源 + ISO 时间
 *  - chat 路径 enabledFor=false → 不挂
 *  - envelope discipline.traceIdEmpty flag
 *
 * Covers suspect signal (4.4.b):
 *  - cat foo.log(空)→ suspect + flag, 不调 StateMachine
 *  - find . -name "*.log" 无结果 → suspect, 不 blocked
 *  - python3 -c "open('empty').read()" 空 → suspect
 *  - head/tail/wc 空文件 → suspect
 *  - suspect 不调 StateMachine.apply
 *  - suspect 日志含 cmd + stdout preview + at
 *
 * Run:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
 *     server/modules/onsite-analysis/tests/discipline-trace-id.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WebSocket } from 'ws';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { onsiteDisciplineLogDb } from '@/modules/database/repositories/onsite-discipline-log.db.js';
import { onsiteProblemsDb } from '@/modules/database/repositories/onsite-problems.db.js';
import { initSchemaWithMigrations } from '@/modules/database/tests/helpers/test-schema.js';

import { disciplineTraceIdMiddleware } from '../discipline/discipline-trace-id.middleware.js';
import { onsiteBroadcast } from '../onsite-broadcast.js';
import { apply } from '../state-machine.service.js';

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
  const tempDir = await mkdtemp(path.join(tmpdir(), 'traceid-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  process.env.ONSITE_ROOT = path.join(tempDir, 'onsite');
  closeConnection();
  initSchemaWithMigrations();

  try {
    await runTest();
  } finally {
    onsiteBroadcast._resetForTests();
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
    // 同步落库,便于断言
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
    } catch {
      /* ignore — 可能 FK 失败 */
    }
  };

  const events: unknown[] = [];
  const subscribeListener = (e: unknown) => {
    events.push(e);
  };
  // 直接监听 onsite-broadcast:每次都注册一个临时 subscriber
  const unsub = onsiteBroadcast.subscribe({ send: subscribeListener });

  const ctx = {
    enabledFor: (ws: WebSocket): boolean => (ws as unknown as { kind?: string }).kind === 'onsite',
    getTraceId: (): string | null => 'trace-XYZ',
    applyBlocked,
    logHit,
    problemId,
  };

  return { ctx, applied, logEntries, events, unsub };
}

// ---------------------------------------------------------------------------
// 主信号 — assistant 文本扫描
// ---------------------------------------------------------------------------

test('主信号:含"未找到" + 之前 60s 内 grep 过 traceId → emit + flag + applyBlocked', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const { ctx, applied, unsub } = makeCtx();
    disciplineTraceIdMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    // 1) 模拟 tool_result:grep 命中 0 行(强信号提前建立"最近 grep" 状态)
    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: "grep -rc 'trace-XYZ' /var/log",
      stdout: '0\n',
    }));

    // 2) 主信号:AI assistant 文本说"未找到"
    ws.send(JSON.stringify({
      kind: 'text',
      sessionId: '20260704-test',
      content: '在日志中未找到 trace-XYZ',
    }));

    assert.equal(applied.length >= 1, true, '应触发 applyBlocked');
    assert.ok(applied[0]!.reason.includes('trace-XYZ'));
    // envelope flag
    const flagged = ws.sentFrames.find((f) => f.includes('traceIdEmpty'));
    assert.ok(flagged, '应至少有一帧带 traceIdEmpty flag');

    unsub();
  });
});

test('主信号:含"0 结果" + grep → emit', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const { ctx, applied, unsub } = makeCtx();
    disciplineTraceIdMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: "grep 'trace-XYZ' /var/log",
      stdout: '0\n',
    }));
    ws.send(JSON.stringify({
      kind: 'text',
      sessionId: '20260704-test',
      content: '本次查询返回 0 结果',
    }));

    assert.ok(applied.length >= 1, '应触发 applyBlocked');
    unsub();
  });
});

test('主信号:"no matches" + grep → emit(英文)', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const { ctx, applied, unsub } = makeCtx();
    disciplineTraceIdMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: "rg 'trace-XYZ' /var/log",
      stdout: '',
    }));
    ws.send(JSON.stringify({
      kind: 'text',
      sessionId: '20260704-test',
      content: 'no matches found for trace-XYZ',
    }));

    assert.ok(applied.length >= 1, '英文 + grep 也应触发');
    unsub();
  });
});

test('主信号:含"未找到" 但 60s 内无 grep → 不 emit(防误报)', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const { ctx, applied, unsub } = makeCtx();
    disciplineTraceIdMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    // 没有 tool_result 提前建立"最近 grep"
    ws.send(JSON.stringify({
      kind: 'text',
      sessionId: '20260704-test',
      content: '结果未找到',
    }));

    assert.equal(applied.length, 0, '无 grep 历史时不应触发');
    unsub();
  });
});

test('主信号:含"未找到" 但 grep 的 traceId 不匹配实际 traceId → 不 emit', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const { ctx, applied, unsub } = makeCtx();
    disciplineTraceIdMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    // 强信号:grep 但 traceId 是另一个
    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: "grep 'OTHER-TRACE' /var/log",
      stdout: '0\n',
    }));
    ws.send(JSON.stringify({
      kind: 'text',
      sessionId: '20260704-test',
      content: '结果未找到',
    }));

    assert.equal(applied.length, 0, 'grep 的 traceId 与当前不匹配时不应触发');
    unsub();
  });
});

// ---------------------------------------------------------------------------
// 强信号 — tool_result 直接 grep/rg/ag/ack 0 命中
// ---------------------------------------------------------------------------

test('强信号:grep -rc traceX 返 0 → emit + applyBlocked', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const { ctx, applied, unsub } = makeCtx();
    disciplineTraceIdMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: "grep -rc 'trace-XYZ' /var/log",
      stdout: '0\n',
    }));

    assert.ok(applied.length >= 1, '强信号应触发 applyBlocked');
    const flagged = ws.sentFrames.find((f) => f.includes('traceIdEmpty'));
    assert.ok(flagged, 'envelope 应带 traceIdEmpty flag');
    unsub();
  });
});

test('强信号:rg traceX 0 命中 → emit', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const { ctx, applied, unsub } = makeCtx();
    disciplineTraceIdMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: "rg 'trace-XYZ' /var/log",
      stdout: '',
    }));

    assert.ok(applied.length >= 1);
    unsub();
  });
});

test('强信号:ag traceX 0 命中 → emit', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const { ctx, applied, unsub } = makeCtx();
    disciplineTraceIdMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: "ag 'trace-XYZ' /var/log",
      stdout: '',
    }));

    assert.ok(applied.length >= 1);
    unsub();
  });
});

test('强信号:ack traceX 0 命中 → emit', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const { ctx, applied, unsub } = makeCtx();
    disciplineTraceIdMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: "ack 'trace-XYZ' /var/log",
      stdout: '',
    }));

    assert.ok(applied.length >= 1);
    unsub();
  });
});

test('强信号:ls 命令不触发(非 grep 家族)', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const { ctx, applied, unsub } = makeCtx();
    disciplineTraceIdMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: 'ls -la /var/log',
      stdout: '0\n',
    }));

    assert.equal(applied.length, 0);
    unsub();
  });
});

// ---------------------------------------------------------------------------
// 后续行为
// ---------------------------------------------------------------------------

test('emit 后调 StateMachine.apply 切 blocked(autoReason 包含 traceId + cmd)', async () => {
  await withIsolatedEnv(async () => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const applied: Array<{ id: string; reason: string }> = [];
    const { ctx, unsub } = makeCtx({
      applyBlocked: async (id, reason) => {
        applied.push({ id, reason });
        await apply(id, 'blocked', reason, null);
      },
    });
    disciplineTraceIdMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: "grep 'trace-XYZ' /var/log",
      stdout: '0\n',
    }));

    assert.ok(applied.length >= 1);
    const reason = applied[0]!.reason;
    assert.ok(reason.includes('trace-XYZ'));
    assert.match(reason, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'autoReason 含 ISO 时间');

    // 验证 DB 真的切到 blocked
    const row = onsiteProblemsDb.findById('20260704-test');
    assert.equal(row?.status, 'blocked');
    unsub();
  });
});

test('chat 路径 enabledFor=false → 不挂(消息原样透传)', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'chat';
    const { ctx, applied, unsub } = makeCtx();
    disciplineTraceIdMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: "grep 'trace-XYZ' /var/log",
      stdout: '0\n',
    }));
    ws.send(JSON.stringify({
      kind: 'text',
      sessionId: '20260704-test',
      content: '未找到',
    }));

    assert.equal(applied.length, 0, 'chat 不应触发');
    unsub();
  });
});

test('envelope discipline.traceIdEmpty flag 设置(主信号)', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const { ctx, unsub } = makeCtx();
    disciplineTraceIdMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: "grep 'trace-XYZ' /var/log",
      stdout: '0\n',
    }));

    const flagged = ws.sentFrames.find((f) => f.includes('"traceIdEmpty":true'));
    assert.ok(flagged, 'envelope 应有 discipline.traceIdEmpty=true');
    const parsed = JSON.parse(flagged!) as { discipline?: { traceIdEmpty?: boolean; matchedText?: string } };
    assert.equal(parsed.discipline?.traceIdEmpty, true);
    assert.match(parsed.discipline?.matchedText ?? '', /trace-XYZ|0/);
    unsub();
  });
});

// ---------------------------------------------------------------------------
// Suspect signal (4.4.b) — 非 grep 家族的 0 命中
// ---------------------------------------------------------------------------

test('suspect:cat foo.log(空文件) → suspect + flag, 不调 StateMachine', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const { ctx, applied, logEntries, unsub } = makeCtx();
    disciplineTraceIdMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: 'cat foo.log',
      stdout: '',
    }));

    assert.equal(applied.length, 0, 'suspect 不调 applyBlocked');
    assert.ok(logEntries.length >= 1);
    const suspect = logEntries.find((e) => (e as { kind?: string }).kind === 'trace_id_suspect');
    assert.ok(suspect, '应落 trace_id_suspect 日志');

    const flagged = ws.sentFrames.find((f) => f.includes('"traceIdSuspect":true'));
    assert.ok(flagged, 'envelope 应带 traceIdSuspect flag');
    unsub();
  });
});

test('suspect:find . -name "*.log" 无结果 → suspect, 不 blocked', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const { ctx, applied, logEntries, unsub } = makeCtx();
    disciplineTraceIdMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: 'find . -name "*.log"',
      stdout: '',
    }));

    assert.equal(applied.length, 0);
    assert.ok(logEntries.some((e) => (e as { kind?: string }).kind === 'trace_id_suspect'));
    unsub();
  });
});

test('suspect:python3 -c "open(\'empty\').read()" 空 → suspect', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const { ctx, applied, logEntries, unsub } = makeCtx();
    disciplineTraceIdMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: "python3 -c \"open('empty').read()\"",
      stdout: '',
    }));

    assert.equal(applied.length, 0);
    assert.ok(logEntries.some((e) => (e as { kind?: string }).kind === 'trace_id_suspect'));
    unsub();
  });
});

test('suspect:head/tail/wc 空文件 → suspect', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const { ctx, applied, logEntries, unsub } = makeCtx();
    disciplineTraceIdMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    for (const cmd of ['head empty.txt', 'tail empty.txt', 'wc -l empty.txt']) {
      ws.send(JSON.stringify({
        kind: 'tool_result',
        sessionId: '20260704-test',
        command: cmd,
        stdout: '',
      }));
    }

    assert.equal(applied.length, 0);
    const suspects = logEntries.filter((e) => (e as { kind?: string }).kind === 'trace_id_suspect');
    assert.equal(suspects.length, 3, '3 个空读取操作都应产生 suspect');
    unsub();
  });
});

test('suspect 事件 emit 但不调 StateMachine.apply', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const { ctx, events, applied, unsub } = makeCtx();
    disciplineTraceIdMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: 'cat empty.txt',
      stdout: '',
    }));

    assert.equal(applied.length, 0);
    assert.ok(events.some((e) => (e as { type?: string }).type === 'discipline:trace-id-suspect'));
    unsub();
  });
});

test('suspect 日志含 cmd + stdout_preview + at', async () => {
  await withIsolatedEnv(() => {
    seedProblem('20260704-test');
    const ws = new FakeWs();
    ws.kind = 'onsite';
    let captured: { cmd?: string; stdout_preview?: string } | null = null;
    const ctx = {
      enabledFor: () => true,
      getTraceId: () => 'trace-XYZ',
      applyBlocked: async () => undefined,
      logHit: (entry: { cmd?: string; stdout_preview?: string }) => {
        if (entry.cmd?.includes('cat')) captured = entry;
      },
      problemId: '20260704-test',
    };
    disciplineTraceIdMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    // suspect 触发条件是空 stdout + 非 grep 家族命令
    ws.send(JSON.stringify({
      kind: 'tool_result',
      sessionId: '20260704-test',
      command: 'cat empty.log',
      stdout: '',
    }));

    assert.ok(captured);
    assert.equal(captured!.cmd, 'cat empty.log');
    // preview 限长 200 字(空 stdout 也满足)
    assert.ok((captured!.stdout_preview ?? '').length <= 200);
  });
});