/**
 * MessagesStore — 单元测试,覆盖:
 *  - append / getByProblemId 往返
 *  - cap 500 + FIFO(超过则丢最老的)
 *  - clear 单 problemId
 *  - 隔离:不同 problemId 的 buffer 不互相干扰
 *
 * Run:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
 *     server/modules/onsite-analysis/tests/messages-store.service.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { messagesStore, MESSAGES_STORE_MAX, type StoredMessage } from '../messages-store.service.js';

function mkMsg(problemId: string, role: 'user' | 'assistant', text: string, ts: number): StoredMessage {
  return { problemId, role, kind: 'text', content: text, ts };
}

test('append + getByProblemId: 顺序按 append 时间', () => {
  messagesStore._clearAllForTests();
  messagesStore.append(mkMsg('p1', 'user', 'hello', 1000));
  messagesStore.append(mkMsg('p1', 'assistant', 'hi', 1100));
  messagesStore.append(mkMsg('p1', 'user', 'next', 1200));

  const got = messagesStore.getByProblemId('p1');
  assert.equal(got.length, 3);
  assert.equal(got[0]!.content, 'hello');
  assert.equal(got[1]!.content, 'hi');
  assert.equal(got[2]!.content, 'next');
  assert.deepEqual(got.map((m) => m.ts), [1000, 1100, 1200]);
});

test('cap = MESSAGES_STORE_MAX(500),超过后 FIFO 丢最老', () => {
  messagesStore._clearAllForTests();
  const cap = MESSAGES_STORE_MAX;
  assert.equal(cap, 500);

  for (let i = 0; i < cap + 50; i += 1) {
    messagesStore.append(mkMsg('p-cap', 'user', `m-${i}`, i));
  }

  const got = messagesStore.getByProblemId('p-cap');
  assert.equal(got.length, cap);
  // 最早的 50 条已被丢,第一条是 m-50
  assert.equal(got[0]!.content, 'm-50');
  // 最后一条是 m-(cap+50-1) = m-549
  assert.equal(got[got.length - 1]!.content, `m-${cap + 50 - 1}`);
});

test('clear: 单 problemId 清空不影响其他', () => {
  messagesStore._clearAllForTests();
  messagesStore.append(mkMsg('p-a', 'user', 'a1', 1));
  messagesStore.append(mkMsg('p-b', 'user', 'b1', 1));
  messagesStore.append(mkMsg('p-a', 'user', 'a2', 2));

  messagesStore.clear('p-a');

  assert.equal(messagesStore.getByProblemId('p-a').length, 0);
  assert.equal(messagesStore.getByProblemId('p-b').length, 1);
});

test('不同 problemId 互相隔离', () => {
  messagesStore._clearAllForTests();
  messagesStore.append(mkMsg('p-iso-1', 'user', 'one', 1));
  messagesStore.append(mkMsg('p-iso-2', 'user', 'two', 2));

  const a = messagesStore.getByProblemId('p-iso-1');
  const b = messagesStore.getByProblemId('p-iso-2');
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0]!.content, 'one');
  assert.equal(b[0]!.content, 'two');
});

test('getByProblemId 返回浅拷贝(外部 push 不影响内部 buffer)', () => {
  messagesStore._clearAllForTests();
  messagesStore.append(mkMsg('p-copy', 'user', 'orig', 1));

  const got = messagesStore.getByProblemId('p-copy');
  got.push(mkMsg('p-copy', 'assistant', 'mutated', 999));

  assert.equal(messagesStore.getByProblemId('p-copy').length, 1);
});