/**
 * onsite-broadcast — 单进程 pub/sub 通道,把 problem 状态变化 / 文件变动
 * 推送给 WebSocket 订阅者。
 *
 * Spec:specs/issue-state.md REQ-3.3
 *
 * 设计要点:
 *  - 进程内 Set<Subscriber> — 单服务进程足够,不跨进程
 *  - try/catch per-subscriber — 一个 subscriber 抛错不影响其他
 *  - subscribe 返 unsubscribe — 避免 leak
 *  - subscriberCount 暴露给测试
 */

import type { ProblemStatus } from './state-machine.service.js';

export type Subscriber = {
  send(event: BroadcastEvent): void;
};

export type BroadcastEvent =
  | { type: 'problems:changed' }
  | {
      type: `problem:${string}:state-changed`;
      payload: {
        id: string;
        from: ProblemStatus;
        to: ProblemStatus;
        reason: string;
        at: string;
      };
    };

const subscribers = new Set<Subscriber>();

export const onsiteBroadcast = {
  subscribe(sub: Subscriber): () => void {
    subscribers.add(sub);
    return () => {
      subscribers.delete(sub);
    };
  },

  unsubscribe(sub: Subscriber): void {
    subscribers.delete(sub);
  },

  broadcast(event: BroadcastEvent): void {
    for (const sub of subscribers) {
      try {
        sub.send(event);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[onsite-broadcast] subscriber threw on ${event.type}: ${message}`);
      }
    }
  },

  subscriberCount(): number {
    return subscribers.size;
  },

  /**
   * Test-only: clears the subscriber set. NEVER call from production code.
   */
  _resetForTests(): void {
    subscribers.clear();
  },
};