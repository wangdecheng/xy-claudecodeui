/**
 * OnsiteChatStream reducer —— 复现"AI 回复渲染两遍"bug 的回归测试。
 *
 * 真实链路:Claude SDK 在一次 assistant 响应里会先发一连串 stream_delta
 * (逐字片段), 再发一个终态 `text` 帧(整段装配好的文本), 然后 stream_end,
 * 最后 complete。Bug 期间, OnsiteChatStream 的 inline 订阅回调把 `text`
 * 当成新消息 append, 渲染出两份完全一样的回复 —— 跟 Claude Code 真实
 * session 里的内容对比一眼就能看出来。
 *
 * 这些用例就是上述序列的最小复现, 跑通意味着 dedup 生效。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { OnsiteChatFrame } from '@shared/onsite-types';

import {
  applyOnsiteChatFrame,
  createInitialOnsiteStreamState,
  __resetOnsiteIdCounterForTests,
  type OnsiteStreamState,
} from './onsiteChatReducer';

function applyAll(state: OnsiteStreamState, frames: OnsiteChatFrame[]): OnsiteStreamState {
  return frames.reduce((s, f) => applyOnsiteChatFrame(s, f), state);
}

test.beforeEach(() => {
  __resetOnsiteIdCounterForTests();
});

test('stream_delta + 终态 text 不重复 —— 单条 assistant 回复', () => {
  // 模拟 Claude SDK 一次正常响应: 5 个 stream_delta 后跟终态 text。
  // 终态 text 的 content 必须等于累积内容(SDK 协议保证), 否则顺序/内容出错。
  const finalText = '我是 Claude Code (Anthropic 官方的 CLI), 底层模型是 **Claude Opus 4.8**, 运行在 Claude Agent SDK 里.';

  const state0 = createInitialOnsiteStreamState();
  const state1 = applyAll(state0, [
    { kind: 'stream_delta', content: '我是 Claude Code ' },
    { kind: 'stream_delta', content: '(Anthropic 官方的 CLI)' },
    { kind: 'stream_delta', content: ', 底层模型是 ' },
    { kind: 'stream_delta', content: '**Claude Opus 4.8**' },
    { kind: 'stream_delta', content: ', 运行在 Claude Agent SDK 里.' },
    { kind: 'text', role: 'assistant', content: finalText },
    { kind: 'stream_end' },
    { kind: 'complete' },
  ]);

  const assistantMessages = state1.messages.filter((m) => m.role === 'assistant');
  assert.equal(assistantMessages.length, 1, 'assistant 回复应只渲染一条');
  assert.equal(assistantMessages[0]?.kind, 'text');
  if (assistantMessages[0]?.kind === 'text') {
    assert.equal(assistantMessages[0].text, finalText);
  }
});

test('text 帧先于 stream_delta flush 到达(竞态) —— 仍只渲染一条', () => {
  // 模拟 SDK 极快完成、text 帧在 100ms timer 触发前就到达。
  // 此时没有 streaming bubble, 但 text 帧必须仍只产生一条 assistant 消息;
  // 后续 stream_end / complete 也不能再 append。
  const finalText = '快速短答';

  const state0 = createInitialOnsiteStreamState();
  const state1 = applyAll(state0, [
    { kind: 'text', role: 'assistant', content: finalText },
    { kind: 'stream_end' },
    { kind: 'complete' },
  ]);

  const assistantMessages = state1.messages.filter((m) => m.role === 'assistant');
  assert.equal(assistantMessages.length, 1);
  if (assistantMessages[0]?.kind === 'text') {
    assert.equal(assistantMessages[0].text, finalText);
  }
});

test('仅 text 帧(无 stream_delta,如历史回放路径)—— 仍正常生成一条 assistant 消息', () => {
  const state0 = createInitialOnsiteStreamState();
  const state1 = applyOnsiteChatFrame(state0, {
    kind: 'text',
    role: 'assistant',
    content: '历史回放的旧消息',
  });

  const assistantMessages = state1.messages.filter((m) => m.role === 'assistant');
  assert.equal(assistantMessages.length, 1);
});

test('user text 帧正常 append', () => {
  // sendText 已经乐观插过一条 user 消息, 服务端 echo 走这里再 append 一条
  // —— 这里只验证 reducer 行为是 append, 不验证去重(去重是 UI 层的事)。
  const state0 = createInitialOnsiteStreamState();
  const state1 = applyOnsiteChatFrame(state0, {
    kind: 'text',
    role: 'user',
    content: '客户:招商银行',
  });

  const userMessages = state1.messages.filter((m) => m.role === 'user');
  assert.equal(userMessages.length, 1);
});

test('tool_use / tool_result 帧正常 append', () => {
  const state0 = createInitialOnsiteStreamState();
  const state1 = applyAll(state0, [
    { kind: 'tool_use', name: 'Bash', content: '{"command":"ls"}' },
    { kind: 'tool_result', name: 'Bash', content: 'README.md' },
  ]);

  const toolMessages = state1.messages.filter((m) => m.role === 'tool');
  assert.equal(toolMessages.length, 2);
  assert.equal(toolMessages[0]?.kind, 'tool_use');
  assert.equal(toolMessages[1]?.kind, 'tool_result');
});

test('多轮 stream_delta + text 序列之间不互相污染', () => {
  // 第二轮响应不应被第一轮的 streaming bubble "吃掉"。
  const state0 = createInitialOnsiteStreamState();
  const state1 = applyAll(state0, [
    // 第一轮
    { kind: 'stream_delta', content: '第一轮 ' },
    { kind: 'stream_delta', content: '回复' },
    { kind: 'text', role: 'assistant', content: '第一轮 回复' },
    { kind: 'stream_end' },
    { kind: 'complete' },
    // 第二轮
    { kind: 'stream_delta', content: '第二轮 ' },
    { kind: 'stream_delta', content: '回复' },
    { kind: 'text', role: 'assistant', content: '第二轮 回复' },
    { kind: 'stream_end' },
    { kind: 'complete' },
  ]);

  const assistantMessages = state1.messages.filter((m) => m.role === 'assistant');
  assert.equal(assistantMessages.length, 2, '两轮响应各一条');
  if (assistantMessages[0]?.kind === 'text') {
    assert.equal(assistantMessages[0].text, '第一轮 回复');
  }
  if (assistantMessages[1]?.kind === 'text') {
    assert.equal(assistantMessages[1].text, '第二轮 回复');
  }
});