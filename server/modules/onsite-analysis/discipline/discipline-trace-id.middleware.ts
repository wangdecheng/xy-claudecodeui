/**
 * discipline-trace-id.middleware — trace id 主/强信号检测。
 *
 * Spec:specs/discipline-trace-id.md REQ-8.x + design.md §D-7.3 + §D-9
 *
 * 设计:
 *  - **主信号**:AI assistant 文本含"未找到/0 结果/no matches/无命中/没有结果/no results"
 *    且过去 60s 内有过 grep/rg/ag/ack <traceId> 操作 → 落日志 + emit + applyBlocked
 *  - **强信号**:tool_result 中 grep/rg/ag/ack ... '<traceId>' 命中 0 行 → 同上
 *
 * 反误报:
 *  - 主信号只在"最近 60s 内 grep 过同一个 traceId"时才触发
 *  - 强信号的 traceId 必须与当前 ws.traceId 一致
 *
 * 注意:ctx.applyBlocked 是注入式(测试可替换),生产 ctx 通过 StateMachine.apply
 * 切到 blocked。emit 通过 onsite-broadcast channel 推送给订阅者。
 *
 * (4.4.b suspect 信号在下一 commit 加,见文件底部扩展点)
 */

import type { WebSocket } from 'ws';

import { onsiteBroadcast } from '../onsite-broadcast.js';

const MAIN_SIGNAL_REGEX = /(未找到|0\s*结果|no matches|found nothing|无命中|没有结果|no results?)/i;
const GREP_FAMILY_CMD_REGEX = /^\s*(grep|rg|ag|ack)\b/;
const SUSPECT_CMD_REGEX = /^\s*(cat|head|tail|wc|xxd|find|python3?|node)\b/;
const EMPTY_STDOUT_REGEX = /^\s*$/;

const GREP_RECENT_WINDOW_MS = 60_000;
const STDOUT_PREVIEW_LIMIT = 200;

type DisciplineKind = 'trace_id_empty' | 'trace_id_suspect';

export type TraceIdLogEntry = {
  problemId: string;
  messageId?: string;
  kind: DisciplineKind;
  word?: string | null;
  position?: number | null;
  cmd?: string | null;
  stdout_preview?: string | null;
};

export type TraceIdContext = {
  enabledFor: (ws: WebSocket) => boolean;
  getTraceId: (ws: WebSocket) => string | null;
  applyBlocked: (problemId: string, reason: string) => Promise<void>;
  logHit: (entry: TraceIdLogEntry) => void;
};

type WsState = {
  lastGrepAt: Map<string, number>;
};

const wsState = new WeakMap<WebSocket, WsState>();

function getState(ws: WebSocket): WsState {
  let s = wsState.get(ws);
  if (!s) {
    s = { lastGrepAt: new Map() };
    wsState.set(ws, s);
  }
  return s;
}

function safeParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractProblemId(envelope: Record<string, unknown>): string | null {
  if (typeof envelope.problemId === 'string' && envelope.problemId.length > 0) return envelope.problemId;
  if (typeof envelope.sessionId === 'string' && envelope.sessionId.length > 0) return envelope.sessionId;
  return null;
}

function extractContent(envelope: Record<string, unknown>): string | null {
  if (typeof envelope.content === 'string') return envelope.content;
  if (typeof envelope.text === 'string') return envelope.text;
  return null;
}

function extractCmd(envelope: Record<string, unknown>): string | null {
  if (typeof envelope.command === 'string') return envelope.command;
  if (typeof envelope.cmd === 'string') return envelope.cmd;
  return null;
}

function extractStdout(envelope: Record<string, unknown>): string {
  if (typeof envelope.stdout === 'string') return envelope.stdout;
  if (typeof envelope.output === 'string') return envelope.output;
  return '';
}

function isStdoutAllZero(stdout: string): boolean {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return true;
  return /^(0\s*\n?)+$/.test(stdout);
}

function withDisciplineFlag(
  envelope: Record<string, unknown>,
  flag: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...envelope,
    discipline: {
      ...((envelope.discipline as Record<string, unknown> | undefined) ?? {}),
      ...flag,
    },
  };
}

function buildAutoReason(opts: {
  traceId: string | null;
  cmd: string;
  matchedText: string;
  signal: 'main' | 'strong';
}): string {
  const tag = opts.signal === 'main' ? '[traceId 主信号]' : '[traceId 强信号]';
  const tracePart = opts.traceId ? `${opts.traceId}` : '<unknown>';
  return `${tag} ${tracePart} 在 ${opts.cmd} 中 0 命中(${opts.matchedText})@${new Date().toISOString()} — 见 CLAUDE.md 第 N 章`;
}

export const disciplineTraceIdMiddleware = {
  attachToWs(ws: WebSocket, ctx: TraceIdContext): void {
    if (!ctx.enabledFor(ws)) return;

    const originalSend = ws.send.bind(ws);
    const state = getState(ws);

    ws.send = ((data: unknown, ...args: unknown[]) => {
      if (typeof data !== 'string') {
        return originalSend(data as never, ...(args as []));
      }

      const envelope = safeParse(data);
      if (!envelope) return originalSend(data as never, ...(args as []));

      const problemId = extractProblemId(envelope);
      const traceId = ctx.getTraceId(ws);
      const messageId =
        typeof envelope.id === 'string' || typeof envelope.id === 'number'
          ? String(envelope.id)
          : undefined;

      // ===== tool_result: 强信号 =====
      if (envelope.kind === 'tool_result') {
        const cmd = extractCmd(envelope);
        if (cmd && GREP_FAMILY_CMD_REGEX.test(cmd)) {
          const stdout = extractStdout(envelope);

          if (traceId && cmd.includes(traceId) && isStdoutAllZero(stdout)) {
            state.lastGrepAt.set(traceId, Date.now());

            const matchedText = stdout.trim() || '0';
            try {
              ctx.logHit({
                problemId: problemId ?? traceId,
                ...(messageId !== undefined ? { messageId } : {}),
                kind: 'trace_id_empty',
                word: matchedText,
                position: null,
                cmd,
                stdout_preview: stdout.slice(0, STDOUT_PREVIEW_LIMIT),
              });
            } catch { /* ignore */ }

            try {
              onsiteBroadcast.broadcast({ type: 'discipline:trace-id-empty' });
            } catch { /* ignore */ }

            if (problemId) {
              const reason = buildAutoReason({ traceId, cmd, matchedText, signal: 'strong' });
              void Promise.resolve(ctx.applyBlocked(problemId, reason)).catch(() => undefined);
            }

            const flagged = withDisciplineFlag(envelope, {
              traceIdEmpty: true,
              matchedText,
              cmd,
            });
            return originalSend(JSON.stringify(flagged) as never, ...(args as []));
          }

          if (traceId && cmd.includes(traceId)) {
            state.lastGrepAt.set(traceId, Date.now());
          }
        } else if (cmd && SUSPECT_CMD_REGEX.test(cmd)) {
          // 弱信号 (suspect, 4.4.b) — 非 grep 家族 + 空 stdout
          const stdout = extractStdout(envelope);
          if (EMPTY_STDOUT_REGEX.test(stdout)) {
            try {
              ctx.logHit({
                problemId: problemId ?? 'unknown',
                ...(messageId !== undefined ? { messageId } : {}),
                kind: 'trace_id_suspect',
                word: null,
                position: null,
                cmd,
                stdout_preview: stdout.slice(0, STDOUT_PREVIEW_LIMIT),
              });
            } catch { /* ignore */ }

            try {
              onsiteBroadcast.broadcast({ type: 'discipline:trace-id-suspect' });
            } catch { /* ignore */ }

            const flagged = withDisciplineFlag(envelope, {
              traceIdSuspect: true,
              cmd,
            });
            return originalSend(JSON.stringify(flagged) as never, ...(args as []));
          }
        }
        return originalSend(data as never, ...(args as []));
      }

      // ===== assistant / text: 主信号 =====
      const content = extractContent(envelope);
      if (content === null) return originalSend(data as never, ...(args as []));

      const match = MAIN_SIGNAL_REGEX.exec(content);
      if (!match) return originalSend(data as never, ...(args as []));

      if (!traceId) return originalSend(data as never, ...(args as []));
      const lastGrep = state.lastGrepAt.get(traceId);
      if (!lastGrep || Date.now() - lastGrep > GREP_RECENT_WINDOW_MS) {
        return originalSend(data as never, ...(args as []));
      }

      const matchedText = match[0]!;
      try {
        ctx.logHit({
          problemId: problemId ?? traceId,
          ...(messageId !== undefined ? { messageId } : {}),
          kind: 'trace_id_empty',
          word: matchedText,
          position: match.index,
          cmd: 'assistant_text',
          stdout_preview: content.slice(0, STDOUT_PREVIEW_LIMIT),
        });
      } catch { /* ignore */ }

      try {
        onsiteBroadcast.broadcast({ type: 'discipline:trace-id-empty' });
      } catch { /* ignore */ }

      if (problemId) {
        const reason = buildAutoReason({ traceId, cmd: 'assistant_text', matchedText, signal: 'main' });
        void Promise.resolve(ctx.applyBlocked(problemId, reason)).catch(() => undefined);
      }

      const flagged = withDisciplineFlag(envelope, {
        traceIdEmpty: true,
        matchedText,
        traceId,
      });
      return originalSend(JSON.stringify(flagged) as never, ...(args as []));
    }) as WebSocket['send'];
  },
};