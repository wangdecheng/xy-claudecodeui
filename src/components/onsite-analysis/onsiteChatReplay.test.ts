/**
 * OnsiteChatReplay 合并逻辑的回归测试 —— 复现"首条 user 消息被 loadMessages
 * 覆盖"的 bug。
 *
 * Bug 复现:
 *  - 新建问题 → mount → reset effect 把 messages 清空
 *  - sendText 乐观插入 user 消息 → messages = [user_msg]
 *  - loadMessages fetch resolve(SDK 跑得快的话,stored 里已经有 assistant text)
 *  - 旧实现直接 setMessages(replayed) → user_msg 被覆盖,UI 看不到首条 user 消息
 *
 * 修复:mergeReplayedMessages 在 current 非空时**追加**而非**替换**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { OnsiteStoredMessage } from '../../stores/onsiteStore';

import { buildReplayedMessages, mergeReplayedMessages } from './onsiteChatReplay';
import type { OnsiteStreamMessage } from './onsiteChatReducer';

function makeStored(over: Partial<OnsiteStoredMessage> = {}): OnsiteStoredMessage {
  return {
    problemId: 'p1',
    role: 'user',
    kind: 'text',
    content: 'x',
    ts: 1,
    ...over,
  };
}

test('regression: loadMessages 不会覆盖已乐观插入的 user 消息(append-only)', () => {
  // 1) sendText 乐观插入:current = [user_msg_local]
  const optimisticUser: OnsiteStreamMessage = {
    id: 'm-0',
    role: 'user',
    kind: 'text',
    text: '客户:占位符\n版本:...\n问题描述:这是一个测试问题',
    ts: 1000,
  };
  const current: OnsiteStreamMessage[] = [optimisticUser];

  // 2) loadMessages resolve:SDK 跑得快,stored 里已有 assistant text(不含 user echo)
  const stored: OnsiteStoredMessage[] = [
    makeStored({ role: 'assistant', kind: 'text', content: '你好,我是 Claude Code', ts: 1100 }),
  ];
  const replayed = buildReplayedMessages(stored);

  // 3) merge → 必须保留 user_msg_local,并追加 assistant_text
  const merged = mergeReplayedMessages(current, replayed);

  assert.equal(merged.length, 2, 'user + assistant 都应保留');
  assert.equal(merged[0]?.id, 'm-0', '乐观插入的 user 消息必须在最前');
  assert.equal(merged[0]?.role, 'user');
  assert.equal(merged[1]?.role, 'assistant');
  assert.equal(merged[1]?.text, '你好,我是 Claude Code');
});

test('regression: loadMessages 不会覆盖已到达的 WS 帧(append-only)', () => {
  // 场景:WS 帧已到达 reducer,流式 assistant bubble 已存在
  const streamingAssistant: OnsiteStreamMessage = {
    id: 'streaming-0',
    role: 'assistant',
    kind: 'text',
    text: '你好,我是 Claude Code (部分流式)',
    ts: 1000,
  };
  const current: OnsiteStreamMessage[] = [streamingAssistant];

  // loadMessages resolve:replayed 包含同样的 assistant text(去重)
  const stored: OnsiteStoredMessage[] = [
    makeStored({ role: 'assistant', kind: 'text', content: '你好,我是 Claude Code', ts: 1000 }),
  ];
  const replayed = buildReplayedMessages(stored);

  const merged = mergeReplayedMessages(current, replayed);

  // replayed 里那个 assistant 跟 streamingAssistant id 不同(一个是 streaming-0,
  // 一个是 srv-...),按当前实现会被追加。但这个用例验证:即使 current 已有内容,
  // merge 不会用 replayed 完全覆盖掉 current。
  assert.equal(merged.length >= 1, true, 'streaming bubble 永远不被丢');
  assert.equal(merged[0]?.id, 'streaming-0', '流式 bubble 在最前');
});

test('regression: 切到老问题(无当前消息)→ replayed 完整填充', () => {
  // 切到老问题,reset effect 把 messages 清空。loadMessages resolve 后应填入历史。
  const current: OnsiteStreamMessage[] = [];
  const stored: OnsiteStoredMessage[] = [
    makeStored({ role: 'user', kind: 'text', content: '之前的问题', ts: 1 }),
    makeStored({ role: 'assistant', kind: 'text', content: '之前的回复', ts: 2 }),
  ];
  const replayed = buildReplayedMessages(stored);

  const merged = mergeReplayedMessages(current, replayed);

  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.role, 'user');
  assert.equal(merged[0]?.text, '之前的问题');
  assert.equal(merged[1]?.role, 'assistant');
});

test('regression: replayed 与 current id 重复时不重复追加', () => {
  // 极端场景:replayed 里有与 current 相同 id 的消息(理论上不会发生,defense-in-depth)
  const a: OnsiteStreamMessage = {
    id: 'srv-p1-100-text',
    role: 'user',
    kind: 'text',
    text: '已存在',
    ts: 100,
  };
  const current: OnsiteStreamMessage[] = [a];

  const stored: OnsiteStoredMessage[] = [
    makeStored({ role: 'user', kind: 'text', content: '已存在', ts: 100 }),
    makeStored({ role: 'assistant', kind: 'text', content: '新一条', ts: 200 }),
  ];
  const replayed = buildReplayedMessages(stored);

  const merged = mergeReplayedMessages(current, replayed);

  assert.equal(merged.length, 2, '已存在的 user + 新增的 assistant');
  assert.equal(merged[0]?.id, 'srv-p1-100-text');
  assert.equal(merged[1]?.text, '新一条');
});

test('buildReplayedMessages: tool_use / tool_result 走 tool role', () => {
  const stored: OnsiteStoredMessage[] = [
    makeStored({ role: 'assistant', kind: 'tool_use', content: 'Bash\nls', ts: 1 }),
    makeStored({ role: 'user', kind: 'tool_result', content: 'README.md', ts: 2 }),
  ];
  const replayed = buildReplayedMessages(stored);

  assert.equal(replayed[0]?.role, 'tool');
  assert.equal(replayed[0]?.kind, 'tool_use');
  assert.equal(replayed[1]?.role, 'tool');
  assert.equal(replayed[1]?.kind, 'tool_result');
});
