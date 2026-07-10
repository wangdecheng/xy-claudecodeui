/**
 * OnsiteChatStream 的纯 reducer —— 把 WS 帧序列转成消息列表 + 累积状态。
 *
 * 抽出来的目的是让"Claude SDK 一次响应会同时发 stream_delta + 终态 text"
 * 这种重复帧场景可以被单元测试覆盖,不必起整个 React 树。
 *
 * 注意:本 reducer 只关心 messages / accumulated / streamingMsgId 三块状态;
 * UI 层的 setMessages / setDiscipline / setRunState / setPendingPermissions /
 * 100ms flush timer 仍由 OnsiteChatStream.tsx 自己管理(在本文件之外)。
 */

import type { OnsiteChatFrame } from '@shared/onsite-types';

export type OnsiteStreamMessage =
  | { id: string; role: 'user'; kind: 'text'; text: string; ts: number }
  | { id: string; role: 'assistant'; kind: 'text'; text: string; ts: number; softening?: boolean }
  | { id: string; role: 'tool'; kind: 'tool_use' | 'tool_result'; name?: string; text: string; ts: number };

export type OnsiteStreamState = {
  messages: OnsiteStreamMessage[];
  accumulated: string;
  /** 跨 stream_delta 复用的稳定 id,保证 React key 不漂移。 */
  streamingMsgId: string;
};

let idCounter = 0;
/** 测试专用 —— 把单调递增计数器归零,避免跨用例的 makeId 漂移。 */
export function __resetOnsiteIdCounterForTests(): void {
  idCounter = 0;
}
function makeId(): string {
  return `m-${idCounter++}`;
}
function nextStreamingId(): string {
  return `streaming-${idCounter++}`;
}

export function createInitialOnsiteStreamState(): OnsiteStreamState {
  return {
    messages: [],
    accumulated: '',
    streamingMsgId: nextStreamingId(),
  };
}

/**
 * 把 streaming bubble (id === streamingMsgId) 就地更新;不存在则追加一个。
 * 这是 stream_delta 累积、终态 text、stream_end/complete flush 共用的更新点。
 */
function updateOrCreateStreamingBubble(
  state: OnsiteStreamState,
  text: string,
  ts: number,
): OnsiteStreamMessage[] {
  const last = state.messages[state.messages.length - 1];
  if (last && last.id === state.streamingMsgId && last.kind === 'text' && last.role === 'assistant') {
    return [...state.messages.slice(0, -1), { ...last, text, ts }];
  }
  return [
    ...state.messages,
    {
      id: state.streamingMsgId,
      role: 'assistant',
      kind: 'text',
      text,
      ts,
    },
  ];
}

/**
 * 处理一帧 WS 消息,返回新的 stream 状态。
 *
 * 关键不变量:
 *  1. assistant `text` 帧必须**替换**(或创建)streaming bubble,不能 append。
 *     Claude SDK 在 stream_delta 之后还会发一份完整文本(见
 *     server/modules/providers/list/claude/claude-sessions.provider.ts:496),
 *     不做合并就会渲染出两份完全相同的回复。
 *  2. user `text` 帧直接 append(本地 sendText 已乐观插入,服务端 echo
 *     也走这里;onsite 路径服务端只 echo 自己消费的 user message,不会重复)。
 *  3. stream_end / complete flush 时,如果当前消息列表里的最后一条不是
 *     streaming bubble(例如 assistant text 刚替换过),updateOrCreateStreamingBubble
 *     仍能正确合并到现有 bubble 上,避免再次 append。
 */
export function applyOnsiteChatFrame(
  state: OnsiteStreamState,
  frame: OnsiteChatFrame,
): OnsiteStreamState {
  const ev = frame;
  if (typeof ev.kind !== 'string') return state;

  const ts = Date.now();
  const content = typeof ev.content === 'string' ? ev.content : '';

  if (ev.kind === 'text') {
    const role: 'user' | 'assistant' = ev.role === 'user' ? 'user' : 'assistant';
    if (role === 'assistant') {
      // 终态文本: 把 streaming bubble 的内容刷成这份(等于累积后的内容),
      // 并把 accumulated 同步成它,这样 stream_end / complete 不会再次 flush。
      return {
        ...state,
        messages: updateOrCreateStreamingBubble(state, content, ts),
        accumulated: content,
      };
    }
    return {
      ...state,
      messages: [
        ...state.messages,
        { id: makeId(), role: 'user', kind: 'text', text: content, ts },
      ],
    };
  }

  if (ev.kind === 'stream_delta') {
    if (!content) return state;
    return { ...state, accumulated: state.accumulated + content };
  }

  if (ev.kind === 'stream_end') {
    const text = state.accumulated;
    if (!text) return { ...state, accumulated: '' };
    return {
      ...state,
      messages: updateOrCreateStreamingBubble(state, text, ts),
      accumulated: '',
    };
  }

  if (ev.kind === 'complete') {
    const remaining = state.accumulated;
    const messages = remaining
      ? updateOrCreateStreamingBubble(state, remaining, ts)
      : state.messages;
    return {
      ...state,
      messages,
      accumulated: '',
      streamingMsgId: nextStreamingId(),
    };
  }

  if (ev.kind === 'tool_use' || ev.kind === 'tool_result') {
    return {
      ...state,
      messages: [
        ...state.messages,
        {
          id: makeId(),
          role: 'tool',
          kind: ev.kind,
          ...(typeof ev.name === 'string' ? { name: ev.name } : {}),
          text: content,
          ts,
        },
      ],
    };
  }

  return state;
}