/**
 * MessagesStore — server-side ring buffer of recent chat messages per problem.
 *
 * Spec:briefs/batch8 I1
 *
 * 设计要点:
 *  - 纯内存 per-problem 队列,FIFO,cap=500
 *  - 不持久化(重启即丢;磁盘上是 source of truth 的 problem.json,
 *    消息回放由 Batch 7 客户端 store + WS subscribe 承担)
 *  - 暴露 append / getByProblemId / clear / clearAllForTests
 *  - 由 OnsiteWebSocketService 在 outbound envelope 上挂钩(只对 ws.kind==='onsite'),
 *    把 assistant / user 消息落到 store
 */

export type StoredMessage = {
  problemId: string;
  role: 'user' | 'assistant';
  kind: 'text' | 'tool_use' | 'tool_result' | 'other';
  content: string;
  ts: number;
};

const MAX_MESSAGES_PER_PROBLEM = 500;

const buffers = new Map<string, StoredMessage[]>();

function getBuffer(problemId: string): StoredMessage[] {
  let buf = buffers.get(problemId);
  if (!buf) {
    buf = [];
    buffers.set(problemId, buf);
  }
  return buf;
}

export const messagesStore = {
  append(entry: StoredMessage): void {
    const buf = getBuffer(entry.problemId);
    buf.push(entry);
    // FIFO trim — 超过 cap 时从头部丢
    if (buf.length > MAX_MESSAGES_PER_PROBLEM) {
      buf.splice(0, buf.length - MAX_MESSAGES_PER_PROBLEM);
    }
  },

  getByProblemId(problemId: string): StoredMessage[] {
    // 返回浅拷贝,避免外部修改内部 buffer
    return getBuffer(problemId).slice();
  },

  size(problemId: string): number {
    return getBuffer(problemId).length;
  },

  clear(problemId: string): void {
    buffers.delete(problemId);
  },

  /**
   * 测试 escape hatch — 清空所有 buffers。生产代码绝不能调。
   */
  _clearAllForTests(): void {
    buffers.clear();
  },
};

export const MESSAGES_STORE_MAX = MAX_MESSAGES_PER_PROBLEM;