/**
 * discipline-softening.middleware — TDD discipline.
 *
 * Covers:
 *  - findWords 中文(可能/大概)命中
 *  - findWords 英文(might/probably)命中
 *  - findWords 安全文本空数组
 *  - findWords 多次命中按位置升序
 *  - containsSoftening true / false
 *  - replaceForUi 把命中词替换为 <softening> tag
 *  - attachToWs 仅在 enabledFor=true 时挂(ws.kind==='onsite')
 *  - 命中落 onsite_discipline_log(kind=softening)
 *  - assistant 消息 envelope 加 discipline.softening flag
 *  - chat 路径 enabledFor=false 不挂载(消息原样透传)
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

import {
  disciplineSofteningMiddleware,
  type DisciplineContext,
} from '../discipline/discipline-softening.middleware.js';

class FakeWs {
  readyState = 1;
  kind: 'chat' | 'onsite' | undefined = undefined;
  sentFrames: string[] = [];
  // 包装过的 send (由 middleware 调用 ws.send 时记下)
  send(data: string): void {
    this.sentFrames.push(data);
  }
}

async function withIsolatedEnv(runTest: () => void | Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousRoot = process.env.ONSITE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'softening-'));
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

// ---------------------------------------------------------------------------
// 纯函数 findWords / containsSoftening
// ---------------------------------------------------------------------------

test('findWords: 中文"可能"命中', () => {
  const matches = disciplineSofteningMiddleware.findWords('这条问题可能是因为配置错误');
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.word, '可能');
  assert.equal(matches[0]?.position, 4);
});

test('findWords: 英文"might"命中', () => {
  const matches = disciplineSofteningMiddleware.findWords('this might be a bug');
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.word, 'might');
});

test('findWords: 安全文本空数组', () => {
  const matches = disciplineSofteningMiddleware.findWords('这个 bug 是因为 NPE');
  assert.deepEqual(matches, []);
});

test('findWords: 多次命中按位置升序', () => {
  const matches = disciplineSofteningMiddleware.findWords('可能大概也许');
  assert.equal(matches.length, 3);
  assert.ok((matches[0]?.position ?? 0) < (matches[1]?.position ?? 0));
  assert.ok((matches[1]?.position ?? 0) < (matches[2]?.position ?? 0));
});

test('findWords: 词表中所有 15 词都命中', () => {
  for (const word of ['可能', '也许', '大概', '或许', '似乎', '看起来像', '应该是', '估计是', 'maybe', 'perhaps', 'probably', 'might', 'could be', 'looks like', 'likely']) {
    const matches = disciplineSofteningMiddleware.findWords(`前缀${word}后缀`);
    assert.ok(matches.length >= 1, `${word} 应命中`);
    assert.ok(matches.some((m) => m.word === word), `${word} 出现在命中列表`);
  }
});

test('containsSoftening: true / false', () => {
  assert.equal(disciplineSofteningMiddleware.containsSoftening('可能是因为 OOM'), true);
  assert.equal(disciplineSofteningMiddleware.containsSoftening('NPE at Main.java:42'), false);
});

// ---------------------------------------------------------------------------
// replaceForUi — UI 渲染辅助
// ---------------------------------------------------------------------------

test('replaceForUi: 把命中词替换为 <softening> tag(不破坏非命中词)', () => {
  const replaced = disciplineSofteningMiddleware.replaceForUi('这条可能因为 NPE');
  assert.match(replaced, /<softening\s+word="可能"\s+position="\d+"\/>可能/);
  assert.match(replaced, /NPE/);
});

// ---------------------------------------------------------------------------
// attachToWs — 集成
// ---------------------------------------------------------------------------

test('attachToWs: 仅在 enabledFor=true 时挂(ws.kind=onsite)', async () => {
  await withIsolatedEnv(() => {
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const ctx: DisciplineContext = {
      enabledFor: () => true,
      logHit: () => undefined,
    };
    disciplineSofteningMiddleware.attachToWs(ws as unknown as WebSocket, ctx);
    // 期望:原 send 被包装 — 发出含"可能"的 assistant 消息时,落日志 + flag
    const outgoing = JSON.stringify({
      kind: 'text',
      sessionId: 's1',
      content: '这个 bug 可能是因为 NPE',
    });
    ws.send(outgoing);
    // 落日志 (kind=softening)
    assert.equal(onsiteDisciplineLogDb.countByProblemId('s1'), 0, '未在 onsite_problems 注册的 problemId 不落库');
  });
});

test('attachToWs: 命中软化词时落 onsite_discipline_log(kind=softening) + envelope flag', async () => {
  await withIsolatedEnv(() => {
    onsiteProblemsDb.insert({
      id: '20260704-test2',
      customer: 'test',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      status: 'pending_info',
      cwd: '/tmp/cwd',
      problem_json_path: null,
    });
    const ws = new FakeWs();
    ws.kind = 'onsite';
    const ctx: DisciplineContext = {
      enabledFor: () => true,
      logHit: (entry) => {
        onsiteDisciplineLogDb.append({
          problem_id: entry.problemId,
          message_id: entry.messageId ?? null,
          kind: entry.kind,
          word: entry.word,
          position: entry.position,
          cmd: null,
          stdout_preview: null,
        });
      },
    };
    disciplineSofteningMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    const outgoing = JSON.stringify({
      kind: 'text',
      sessionId: '20260704-test2',
      content: '这条问题可能是因为配置错误',
    });
    ws.send(outgoing);

    assert.equal(onsiteDisciplineLogDb.countByProblemId('20260704-test2'), 1);
  });
});

test('attachToWs: 命中软化词 + ctx 携带 problemId 时正确落库', async () => {
  await withIsolatedEnv(() => {
    // FK 约束要求 onsite_discipline_log.problem_id 必须在 onsite_problems 存在
    onsiteProblemsDb.insert({
      id: '20260704-test',
      customer: 'test',
      third_bridge_branch: null,
      iteration: 'master_5.2_3.2',
      database: 'db01',
      status: 'pending_info',
      cwd: '/tmp/cwd',
      problem_json_path: null,
    });

    const ws = new FakeWs();
    ws.kind = 'onsite';
    const ctx: DisciplineContext = {
      enabledFor: () => true,
      logHit: (entry) => {
        onsiteDisciplineLogDb.append({
          problem_id: entry.problemId,
          message_id: entry.messageId ?? null,
          kind: entry.kind,
          word: entry.word,
          position: entry.position,
          cmd: null,
          stdout_preview: null,
        });
      },
    };
    disciplineSofteningMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    // 通过 wrapper 让 middleware 能拿到 problemId — 用 envelope 里显式 problemId 字段
    const outgoing = JSON.stringify({
      kind: 'text',
      sessionId: 's1',
      problemId: '20260704-test',
      content: '这条问题可能是因为配置错误',
    });
    ws.send(outgoing);

    assert.equal(onsiteDisciplineLogDb.countByProblemId('20260704-test'), 1);
  });
});

test('attachToWs: chat 路径(enabledFor=false)消息原样透传,不入库', async () => {
  await withIsolatedEnv(() => {
    const ws = new FakeWs();
    ws.kind = 'chat';
    const ctx: DisciplineContext = {
      enabledFor: () => false,
      logHit: () => undefined,
    };
    disciplineSofteningMiddleware.attachToWs(ws as unknown as WebSocket, ctx);

    const original = JSON.stringify({
      kind: 'text',
      sessionId: 's1',
      content: '可能的问题', // chat 不应被拦截
    });
    ws.send(original);

    assert.deepEqual(ws.sentFrames, [original], 'chat 路径消息原样');
    assert.equal(onsiteDisciplineLogDb.countByProblemId('s1'), 0);
  });
});