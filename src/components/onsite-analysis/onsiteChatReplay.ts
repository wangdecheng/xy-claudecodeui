/**
 * OnsiteChatStream 的历史回放合并逻辑 —— 纯函数,易测。
 *
 * 背景:OnsiteChatStream mount 时会从 server 端 messagesStore / 磁盘 JSONL
 * 拉历史消息回放(参见 loadMessages effect)。但回放的时机不可控:若 fetch
 * 解析时,WS 已开始送帧或本地 sendText 已乐观插入 user 消息,无脑 setMessages
 * 会把乐观插入/in-flight 帧覆盖掉,导致用户首条消息消失。
 *
 * 修复:把"是否覆盖"的判断抽成纯函数。当前 messages 非空时,只追加 replayed
 * 中尚未出现过的消息;为空时,直接用 replayed 填充(老问题切换的常见路径)。
 *
 * 去重 key:消息 id 字符串。replayed 来自 server,id 形如 `srv-<problemId>-<ts>-<kind>`;
 * 本地消息 id 形如 `m-<n>`(reducer makeId)或 `streaming-<n>`。两套命名空间天然
 * 不会撞,所以 set 判等即可。
 */
import type { OnsiteStreamMessage } from './onsiteChatReducer';
import type { OnsiteStoredMessage } from '../../stores/onsiteStore';

export function buildReplayedMessages(stored: OnsiteStoredMessage[]): OnsiteStreamMessage[] {
  return stored.map((m) => {
    if (m.kind === 'tool_use' || m.kind === 'tool_result') {
      return {
        id: `srv-${m.problemId}-${m.ts}-${m.kind}`,
        role: 'tool',
        kind: m.kind,
        text: m.content,
        ts: m.ts,
      };
    }
    return {
      id: `srv-${m.problemId}-${m.ts}-${m.kind}`,
      role: m.role === 'user' ? 'user' : 'assistant',
      kind: 'text',
      text: m.content,
      ts: m.ts,
    };
  });
}

/**
 * 把 replayed 历史消息合并进当前 messages 状态。
 *
 * - 当前 messages 为空(典型场景:从无历史问题切换过来、刚 reset 过)→ 用 replayed 填充
 * - 当前 messages 非空(典型场景:刚 sendText 完、WS 已开始送帧)→ 保留 current,只追加
 *   replayed 中**未出现过**的(按 id 判等)
 *
 * 返回的数组保证:
 *  1. current 顺序不变
 *  2. 新追加的 replayed 元素按原顺序排在 current 之后
 *  3. 任何 id 重复的元素只保留 current 那一份(replayed 里的副本被丢弃)
 */
export function mergeReplayedMessages(
  current: OnsiteStreamMessage[],
  replayed: OnsiteStreamMessage[],
): OnsiteStreamMessage[] {
  if (current.length === 0) {
    return replayed;
  }
  const seen = new Set(current.map((m) => m.id));
  const additions: OnsiteStreamMessage[] = [];
  for (const m of replayed) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    additions.push(m);
  }
  if (additions.length === 0) return current;
  return [...current, ...additions];
}
