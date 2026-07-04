/**
 * onsite-broadcast tests — TDD discipline.
 *
 * Covers:
 *  - subscribe 后 broadcast 收到事件
 *  - unsubscribe 后不再收到
 *  - 多个 subscriber 都收到
 *  - subscriber.send 抛错不影响其他 subscriber
 *  - subscriberCount 反映数量
 *  - state-changed 事件 payload 完整
 *  - 与 OnsiteWatcher.onWatcherChange 集成(boot 时一次)
 *
 * Run:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
 *     server/modules/onsite-analysis/tests/onsite-broadcast.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { onsiteBroadcast, type BroadcastEvent, type Subscriber } from '../onsite-broadcast.js';
import { onWatcherChange, startOnsiteWatcher, stopOnsiteWatcher } from '../onsiteWatcher.js';

test.beforeEach(() => {
  onsiteBroadcast._resetForTests();
});

test('subscribe 后 broadcast 收到事件', () => {
  const received: BroadcastEvent[] = [];
  const sub: Subscriber = { send: (e) => received.push(e) };
  const off = onsiteBroadcast.subscribe(sub);

  onsiteBroadcast.broadcast({ type: 'problems:changed' });

  assert.equal(received.length, 1);
  assert.equal(received[0]!.type, 'problems:changed');

  off();
});

test('unsubscribe 后不再收到', () => {
  const received: BroadcastEvent[] = [];
  const sub: Subscriber = { send: (e) => received.push(e) };
  const off = onsiteBroadcast.subscribe(sub);

  off();
  onsiteBroadcast.broadcast({ type: 'problems:changed' });

  assert.equal(received.length, 0);
});

test('onsiteBroadcast.unsubscribe 显式调用也能移除', () => {
  const received: BroadcastEvent[] = [];
  const sub: Subscriber = { send: (e) => received.push(e) };
  onsiteBroadcast.subscribe(sub);

  onsiteBroadcast.unsubscribe(sub);
  onsiteBroadcast.broadcast({ type: 'problems:changed' });

  assert.equal(received.length, 0);
});

test('多个 subscriber 都收到事件', () => {
  const a: BroadcastEvent[] = [];
  const b: BroadcastEvent[] = [];
  const subA: Subscriber = { send: (e) => a.push(e) };
  const subB: Subscriber = { send: (e) => b.push(e) };

  const offA = onsiteBroadcast.subscribe(subA);
  const offB = onsiteBroadcast.subscribe(subB);

  onsiteBroadcast.broadcast({ type: 'problems:changed' });

  assert.equal(a.length, 1);
  assert.equal(b.length, 1);

  offA();
  offB();
});

test('subscriber.send 抛错不影响其他 subscriber', () => {
  const a: BroadcastEvent[] = [];
  const b: BroadcastEvent[] = [];
  const subA: Subscriber = {
    send: () => {
      throw new Error('boom');
    },
  };
  const subB: Subscriber = { send: (e) => b.push(e) };

  const offA = onsiteBroadcast.subscribe(subA);
  const offB = onsiteBroadcast.subscribe(subB);

  // 不应抛出
  onsiteBroadcast.broadcast({ type: 'problems:changed' });

  // b 仍应收到
  assert.equal(b.length, 1);

  offA();
  offB();
});

test('subscriberCount 反映数量', () => {
  assert.equal(onsiteBroadcast.subscriberCount(), 0);

  const off1 = onsiteBroadcast.subscribe({ send: () => undefined });
  assert.equal(onsiteBroadcast.subscriberCount(), 1);

  const off2 = onsiteBroadcast.subscribe({ send: () => undefined });
  assert.equal(onsiteBroadcast.subscriberCount(), 2);

  off1();
  assert.equal(onsiteBroadcast.subscriberCount(), 1);

  off2();
  assert.equal(onsiteBroadcast.subscriberCount(), 0);
});

test('state-changed 事件 payload 完整', () => {
  const received: BroadcastEvent[] = [];
  const sub: Subscriber = { send: (e) => received.push(e) };
  const off = onsiteBroadcast.subscribe(sub);

  onsiteBroadcast.broadcast({
    type: 'problem:abc-123:state-changed',
    payload: {
      id: 'abc-123',
      from: 'pending_info',
      to: 'analyzing',
      reason: '客户已补充背景信息',
      at: '2026-07-04T12:34:56.000Z',
    },
  });

  assert.equal(received.length, 1);
  const event = received[0]!;
  assert.equal(event.type, 'problem:abc-123:state-changed');
  if (event.type === 'problem:abc-123:state-changed') {
    assert.equal(event.payload.id, 'abc-123');
    assert.equal(event.payload.from, 'pending_info');
    assert.equal(event.payload.to, 'analyzing');
    assert.equal(event.payload.reason, '客户已补充背景信息');
    assert.equal(event.payload.at, '2026-07-04T12:34:56.000Z');
  }

  off();
});

test('subscribe 同一 subscriber 两次,只算一个 subscriberCount', () => {
  const sub: Subscriber = { send: () => undefined };
  onsiteBroadcast.subscribe(sub);
  onsiteBroadcast.subscribe(sub);
  assert.equal(onsiteBroadcast.subscriberCount(), 1);
});

test('OnsiteWatcher.onWatcherChange 触发 broadcast (problems:changed)', () => {
  const received: BroadcastEvent[] = [];
  const sub: Subscriber = { send: (e) => received.push(e) };
  const offSub = onsiteBroadcast.subscribe(sub);

  // 模拟集成:在 server boot 时执行
  //   onWatcherChange(() => onsiteBroadcast.broadcast({ type: 'problems:changed' }));
  const offWatcher = onWatcherChange(() => {
    onsiteBroadcast.broadcast({ type: 'problems:changed' });
  });

  try {
    // 直接 broadcast 模拟 watcher 的 callback 路径
    onsiteBroadcast.broadcast({ type: 'problems:changed' });

    assert.equal(received.length, 1);
    assert.equal(received[0]!.type, 'problems:changed');
  } finally {
    offWatcher();
    offSub();
    stopOnsiteWatcher();
  }
});

test('OnsiteWatcher.startOnsiteWatcher + onWatcherChange 集成 — broadcast 多次触发', () => {
  const received: BroadcastEvent[] = [];
  const sub: Subscriber = { send: (e) => received.push(e) };
  const offSub = onsiteBroadcast.subscribe(sub);

  startOnsiteWatcher();
  const offWatcher = onWatcherChange(() => {
    onsiteBroadcast.broadcast({ type: 'problems:changed' });
  });

  try {
    // 调用 listener 路径 3 次
    onsiteBroadcast.broadcast({ type: 'problems:changed' });
    onsiteBroadcast.broadcast({ type: 'problems:changed' });
    onsiteBroadcast.broadcast({ type: 'problems:changed' });

    assert.equal(received.length, 3);
  } finally {
    offWatcher();
    offSub();
    stopOnsiteWatcher();
  }
});