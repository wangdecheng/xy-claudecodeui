/**
 * claude-code-history.service — TDD 覆盖 parseJsonlToMessages 和
 * loadHistoryFromClaudeCode(后者用临时目录隔离 ~/.claude 路径)。
 *
 * 关键场景:
 *  - 空/坏 JSONL 行容错
 *  - timestamp < createdAt 过滤
 *  - user 文本 → user role + text kind
 *  - assistant 文本块 → assistant role + text kind
 *  - assistant thinking 块被丢弃
 *  - assistant 字符串 content(罕见) → 不产出消息
 *  - 跨文件消息按 ts 升序合并
 *  - 超过 MAX_MESSAGES cap → 取最后 N 条
 *  - project 目录不存在 → 返回空数组,不抛
 *
 * Run:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
 *     server/modules/onsite-analysis/tests/claude-code-history.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadHistoryFromClaudeCode,
  parseJsonlToMessages,
} from '../claude-code-history.service.js';

const FIXTURE_CWD = '/Users/xylink/work/customer-onsite-analysis/20260703-zhongche';
const FIXTURE_PROJECT_DIR = path.join(
  '/Users/xylink/.claude/projects/-Users-xylink-work-customer-onsite-analysis',
);

test('parseJsonlToMessages 空字符串 → 空数组', () => {
  const out = parseJsonlToMessages('', 'p1', 0, '20260703-zhongche');
  assert.deepEqual(out, []);
});

test('parseJsonlToMessages 坏行(JSON 解析失败)容错', () => {
  const jsonl = [
    '{not valid json',
    '',
    '{"type":"user","timestamp":"2026-07-03T08:00:00Z","message":{"role":"user","content":"hi 20260703-zhongche"}}',
  ].join('\n');
  const out = parseJsonlToMessages(jsonl, 'p1', 0, '20260703-zhongche');
  assert.equal(out.length, 1);
  assert.equal(out[0]?.content, 'hi 20260703-zhongche');
  assert.equal(out[0]?.role, 'user');
});

test('parseJsonlToMessages timestamp < createdAt 过滤', () => {
  const jsonl = [
    '{"type":"user","timestamp":"2026-07-01T00:00:00Z","message":{"role":"user","content":"old 20260703-zhongche"}}',
    '{"type":"user","timestamp":"2026-07-05T00:00:00Z","message":{"role":"user","content":"new 20260703-zhongche"}}',
  ].join('\n');
  const out = parseJsonlToMessages(jsonl, 'p1', Date.parse('2026-07-03T00:00:00Z'), '20260703-zhongche');
  assert.equal(out.length, 1);
  assert.equal(out[0]?.content, 'new 20260703-zhongche');
});

test('parseJsonlToMessages assistant text 块 → role=assistant kind=text', () => {
  const jsonl = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-03T08:00:00Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '...' },
        { type: 'text', text: 'Hello' },
      ],
    },
  });
  const out = parseJsonlToMessages(jsonl, 'p1', 0, '');
  assert.equal(out.length, 1);
  assert.equal(out[0]?.role, 'assistant');
  assert.equal(out[0]?.kind, 'text');
  assert.equal(out[0]?.content, 'Hello');
});

test('parseJsonlToMessages assistant 多个 text 块 → 多条消息', () => {
  const jsonl = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-03T08:00:00Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'first' },
        { type: 'thinking', thinking: 'skip me' },
        { type: 'text', text: 'second' },
      ],
    },
  });
  const out = parseJsonlToMessages(jsonl, 'p1', 0, '');
  assert.equal(out.length, 2);
  assert.equal(out[0]?.content, 'first');
  assert.equal(out[1]?.content, 'second');
});

test('parseJsonlToMessages assistant content 是字符串(罕见) → 不产出', () => {
  // Claude Code 通常是 array; 字符串 content 在 SDK 模式下可能出现。
  // 本服务只关心 UI 重放所需,字符串 content 不解析。
  const jsonl = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-03T08:00:00Z',
    message: { role: 'assistant', content: 'plain string' },
  });
  const out = parseJsonlToMessages(jsonl, 'p1', 0, '');
  assert.equal(out.length, 0);
});

test('parseJsonlToMessages user 空字符串 content → 不产出', () => {
  const jsonl = JSON.stringify({
    type: 'user',
    timestamp: '2026-07-03T08:00:00Z',
    message: { role: 'user', content: '   ' },
  });
  const out = parseJsonlToMessages(jsonl, 'p1', 0, '');
  assert.equal(out.length, 0);
});

test('parseJsonlToMessages system/mode/permission-mode 行 → 不产出', () => {
  const jsonl = [
    '{"type":"last-prompt","timestamp":"2026-07-03T08:00:00Z"}',
    '{"type":"mode","timestamp":"2026-07-03T08:00:00Z","mode":"normal"}',
    '{"type":"permission-mode","timestamp":"2026-07-03T08:00:00Z"}',
  ].join('\n');
  const out = parseJsonlToMessages(jsonl, 'p1', 0, '');
  assert.equal(out.length, 0);
});

test('parseJsonlToMessages 没 timestamp 的行 → 跳过', () => {
  const jsonl = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'no ts' },
  });
  const out = parseJsonlToMessages(jsonl, 'p1', 0, '');
  assert.equal(out.length, 0);
});

test('parseJsonlToMessages cwdSlug 命中(user 文本包含 slug)→ 保留', () => {
  // 跨 problem 隔离核心:同一 JSONL 文件被多个 problem 共享,只有当
  // user 文本明确包含本 problem 的 slug(目录 basename)时,才视为
  // 属于本 problem;否则整文件跳过(避免其他 problem 的消息泄漏)。
  const jsonl = [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-07-03T08:00:00Z',
      message: {
        role: 'user',
        content: '请帮我看看 20260703-zhongche 这个问题的日志',
      },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-03T08:01:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '好的,我来看看' }],
      },
    }),
  ].join('\n');
  const out = parseJsonlToMessages(jsonl, 'p1', 0, '20260703-zhongche');
  assert.equal(out.length, 2);
  assert.equal(out[0]?.role, 'user');
  assert.equal(out[0]?.content.includes('20260703-zhongche'), true);
  assert.equal(out[1]?.role, 'assistant');
});

test('parseJsonlToMessages cwdSlug 不命中 → 整文件跳过(防止跨 problem 泄漏)', () => {
  // 该 JSONL 来自其他 problem(20260703-zhongche),但当前在查 20260706-test
  // → slug 不命中 → 应当返回空,不让其他 problem 的消息污染 UI。
  const jsonl = [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-07-03T08:00:00Z',
      message: {
        role: 'user',
        content: '请帮我看 20260703-zhongche 的日志',
      },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-03T08:01:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '好的' }],
      },
    }),
  ].join('\n');
  const out = parseJsonlToMessages(jsonl, 'p1', 0, '20260706-test');
  assert.equal(out.length, 0);
});

test('parseJsonlToMessages user 文本不含 slug 但 cwd 匹配 → 保留', () => {
  const jsonl = [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-07-06T11:05:23.464Z',
      cwd: '/Users/xylink/work/customer-onsite-analysis/20260706-不涉及三方对接_4',
      message: { role: 'user', content: [{ type: 'text', text: '你好' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-06T11:05:34.118Z',
      cwd: '/Users/xylink/work/customer-onsite-analysis/20260706-不涉及三方对接_4',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '你好,我来看看。' }],
      },
    }),
  ].join('\n');

  const out = parseJsonlToMessages(
    jsonl,
    'p-onsite',
    0,
    '20260706-不涉及三方对接_4',
    '/Users/xylink/work/customer-onsite-analysis/20260706-不涉及三方对接_4',
  );

  assert.equal(out.length, 2);
  assert.equal(out[0]?.role, 'user');
  assert.equal(out[0]?.content, '你好');
  assert.equal(out[1]?.role, 'assistant');
});

test('parseJsonlToMessages cwdSlug 为空 → 不过滤(向后兼容旧调用)', () => {
  // 旧调用方可能不传 slug,此时回归到「纯时间过滤」行为,避免回归。
  const jsonl = JSON.stringify({
    type: 'user',
    timestamp: '2026-07-03T08:00:00Z',
    message: { role: 'user', content: 'any text' },
  });
  const out = parseJsonlToMessages(jsonl, 'p1', 0, '');
  assert.equal(out.length, 1);
});

// ---------------------------------------------------------------------------
// loadHistoryFromClaudeCode — 隔离 ~/.claude/projects 的真实目录
// ---------------------------------------------------------------------------

test('loadHistoryFromClaudeCode project 目录不存在 → 返回空,不抛', async () => {
  // 用一个肯定不存在的 cwd
  const out = await loadHistoryFromClaudeCode(
    'p1',
    '/nonexistent/path/20260101-foo',
    0,
  );
  assert.deepEqual(out, []);
});

test('loadHistoryFromClaudeCode 注入临时 claudeHome,跨文件按 ts 升序合并 + 时间过滤', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'cc-history-'));
  try {
    // tmp 模拟 ~/.claude/projects 根目录
    // 在 tmp 下建出 -Users-xylink-work-customer-onsite-analysis/
    const projectDir = path.join(tmp, '-Users-xylink-work-customer-onsite-analysis');
    await mkdir(projectDir, { recursive: true });
    // 三条都包含本 problem 的 slug(20260703-zhongche)→ 全部锚定
    const sessionA = JSON.stringify({
      type: 'user',
      timestamp: '2026-07-03T07:30:00Z',
      message: { role: 'user', content: '请看 20260703-zhongche 的 A' },
    });
    const sessionB = [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-03T07:30:30Z',
        message: { role: 'user', content: '20260703-zhongche 的 B 入参' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-03T07:35:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'B 响应 20260703-zhongche' }],
        },
      }),
    ].join('\n');
    const sessionC = JSON.stringify({
      type: 'user',
      timestamp: '2026-07-03T07:25:00Z', // 更早
      message: { role: 'user', content: '20260703-zhongche 的 C(更早)' },
    });
    await writeFile(path.join(projectDir, 'a.jsonl'), sessionA);
    await writeFile(path.join(projectDir, 'b.jsonl'), sessionB);
    await writeFile(path.join(projectDir, 'c.jsonl'), sessionC);
    await writeFile(path.join(projectDir, 'README.md'), 'ignore me');

    const out = await loadHistoryFromClaudeCode(
      'p-zhongche',
      '/Users/xylink/work/customer-onsite-analysis/20260703-zhongche',
      Date.parse('2026-07-03T00:00:00Z'),
      tmp, // 注入临时根
    );
    // 期望按 ts 升序:C(07:25) → A(07:30) → B-user(07:30:30) → B-assistant(07:35)
    assert.equal(out.length, 4);
    assert.equal(out[0]?.content, '20260703-zhongche 的 C(更早)');
    assert.equal(out[1]?.content, '请看 20260703-zhongche 的 A');
    assert.equal(out[2]?.content, '20260703-zhongche 的 B 入参');
    assert.equal(out[2]?.role, 'user');
    assert.equal(out[3]?.content, 'B 响应 20260703-zhongche');
    assert.equal(out[3]?.role, 'assistant');
    // README.md 应被忽略
    assert.ok(!out.some((m) => m.content.includes('README')));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('loadHistoryFromClaudeCode 优先读取完整 problem cwd 对应的 Claude project 目录', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'cc-history-'));
  try {
    const problemDir = path.join(tmp, '-Users-xylink-work-customer-onsite-analysis-20260703-zhongche');
    await mkdir(problemDir, { recursive: true });
    await writeFile(
      path.join(problemDir, 'session.jsonl'),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-03T07:30:00Z',
        message: { role: 'user', content: '请看 20260703-zhongche 的完整 cwd 会话' },
      }),
    );

    const out = await loadHistoryFromClaudeCode(
      'p-zhongche',
      '/Users/xylink/work/customer-onsite-analysis/20260703-zhongche',
      Date.parse('2026-07-03T00:00:00Z'),
      tmp,
    );

    assert.equal(out.length, 1);
    assert.equal(out[0]?.content, '请看 20260703-zhongche 的完整 cwd 会话');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('loadHistoryFromClaudeCode 注入临时 claudeHome,createdAt 过滤生效', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'cc-history-'));
  try {
    const projectDir = path.join(tmp, '-Users-xylink-work-customer-onsite-analysis');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'a.jsonl'),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-01T00:00:00Z',
        message: { role: 'user', content: 'old 20260703-zhongche' },
      }),
    );
    await writeFile(
      path.join(projectDir, 'b.jsonl'),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-05T00:00:00Z',
        message: { role: 'user', content: 'new 20260703-zhongche' },
      }),
    );
    const out = await loadHistoryFromClaudeCode(
      'p1',
      '/Users/xylink/work/customer-onsite-analysis/20260703-zhongche',
      Date.parse('2026-07-03T00:00:00Z'),
      tmp,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]?.content, 'new 20260703-zhongche');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('parseJsonlToMessages 完整 user + assistant 往返示例', () => {
  const jsonl = [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-07-03T08:00:00Z',
      message: { role: 'user', content: '帮忙看看 20260703-zhongche 的问题' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-03T08:00:05Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '让我分析一下' },
          { type: 'text', text: '好的,我先看一下 20260703-zhongche 的日志。' },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-07-03T08:00:10Z',
      message: { role: 'user', content: '日志在 20260703-zhongche cwd 下' },
    }),
  ].join('\n');

  const out = parseJsonlToMessages(jsonl, 'p-zhongche', 0, '20260703-zhongche');
  assert.equal(out.length, 3);
  assert.equal(out[0]?.role, 'user');
  assert.equal(out[0]?.content, '帮忙看看 20260703-zhongche 的问题');
  assert.equal(out[1]?.role, 'assistant');
  assert.equal(out[1]?.content, '好的,我先看一下 20260703-zhongche 的日志。');
  assert.equal(out[2]?.role, 'user');
  assert.deepEqual(
    out.map((m) => m.problemId),
    ['p-zhongche', 'p-zhongche', 'p-zhongche'],
  );
});

// ---------------------------------------------------------------------------
// encodeProjectPath:含非 ASCII 字符的 problem cwd 必须与磁盘目录命名一致
// ---------------------------------------------------------------------------
// 回归用例:onsite problem 目录名常含中文(如「不涉及三方对接」)。
// Claude Code 磁盘目录把每个非 [a-zA-Z0-9-] 字符都替换为 -,因此
// /Users/.../20260707-不涉及三方对接
// 在磁盘上是 -Users-...-20260707--------
// 旧实现只把 / 替换为 - 会保留中文,扫不到磁盘目录,历史加载为空。
test('loadHistoryFromClaudeCode 含中文 cwd 的 problem 能扫到磁盘 JSONL(encodeProjectPath 与磁盘一致)', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'cc-history-'));
  try {
    // 模拟 Claude Code 在磁盘上创建的目录名(中文已替换为 -)
    const projectDir = path.join(
      tmp,
      '-Users-xylink-work-customer-onsite-analysis-20260707--------',
    );
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'session.jsonl'),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-07T03:26:11.586Z',
        cwd: '/Users/xylink/work/customer-onsite-analysis/20260707-不涉及三方对接',
        message: { role: 'user', content: [{ type: 'text', text: '你好' }] },
      }),
    );

    const out = await loadHistoryFromClaudeCode(
      'p-cn',
      '/Users/xylink/work/customer-onsite-analysis/20260707-不涉及三方对接',
      Date.parse('2026-07-07T00:00:00Z'),
      tmp,
    );

    assert.equal(out.length, 1);
    assert.equal(out[0]?.content, '你好');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
