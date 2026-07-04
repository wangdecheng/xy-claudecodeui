/**
 * discipline-write-protection.middleware — 写原日志路径软审计。
 *
 * Spec:specs/discipline-write-protection.md REQ-9.x + design.md §D-7.4
 *
 * 设计:
 *  - **两正则同时命中** 才算 hit:
 *    1. WRITE_ACTION_REGEX:rm / rm -rf / tee / cp -f / mv / sed -i / awk -i / 重定向 >
 *    2. ORIGINAL_PATH_REGEX:受保护路径(.log / .log.gz / .jsonl / .tar.gz / .tgz /
 *       problem.json / unpacked-*)
 *  - 命中 → 落 onsite_discipline_log(kind=write_protection) + emit + envelope flag
 *  - **不调 StateMachine.apply**(软审计,只是记录)
 *
 * 注意:这是软审计,Batch 5 会加入 SDK 层 disallowedTools 黑名单(硬层);
 * 软 + 硬双层就位后,raw-log 写动作会被双拦截。
 */

import type { WebSocket } from 'ws';

import { onsiteBroadcast } from '../onsite-broadcast.js';

const WRITE_ACTION_REGEX = /\b(?:rm(?:\s+-rf)?|tee|cp\s+-f|mv|sed\s+-i|awk\s+-i)\b|>(?!>)/;
const ORIGINAL_PATH_REGEX = /(?:^|\s|\/|\\)([^\\\/\s]+\.(?:log|log\.gz|jsonl|tar\.gz|tgz)|problem\.json|unpacked-[\w-]+)(?=\s|$|\/|\\)/;

const STDOUT_PREVIEW_LIMIT = 200;

export type WriteProtectionHit = { hit: true; cmd: string };

type DisciplineKind = 'write_protection';

export type WriteProtectionLogEntry = {
  problemId: string;
  messageId?: string;
  kind: DisciplineKind;
  cmd: string;
  stdout_preview: string | null;
};

export type WriteProtectionContext = {
  enabledFor: (ws: WebSocket) => boolean;
  logHit: (entry: WriteProtectionLogEntry) => void;
};

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

function withDisciplineFlag(envelope: Record<string, unknown>, flag: Record<string, unknown>): Record<string, unknown> {
  return {
    ...envelope,
    discipline: {
      ...((envelope.discipline as Record<string, unknown> | undefined) ?? {}),
      ...flag,
    },
  };
}

export const disciplineWriteProtectionMiddleware = {
  /**
   * Pure — 检测命令是否同时命中写动作 + 原始日志路径。
   */
  detect(command: string): WriteProtectionHit | { hit: false } {
    if (!WRITE_ACTION_REGEX.test(command)) {
      return { hit: false };
    }
    if (!ORIGINAL_PATH_REGEX.test(command)) {
      return { hit: false };
    }
    return { hit: true, cmd: command };
  },

  /**
   * 包装 ws.send:只对 ws.kind === 'onsite' 的 ws 生效。
   * - tool_result 中命令同时命中写动作 + 受保护路径 → 落日志 + emit + envelope flag
   * - 不调 StateMachine.apply(软审计)
   */
  attachToWs(ws: WebSocket, ctx: WriteProtectionContext): void {
    if (!ctx.enabledFor(ws)) return;

    const originalSend = ws.send.bind(ws);

    ws.send = ((data: unknown, ...args: unknown[]) => {
      if (typeof data !== 'string') {
        return originalSend(data as never, ...(args as []));
      }

      const envelope = safeParse(data);
      if (!envelope) return originalSend(data as never, ...(args as []));

      if (envelope.kind !== 'tool_result') {
        return originalSend(data as never, ...(args as []));
      }

      const cmd = extractCmd(envelope);
      if (!cmd) return originalSend(data as never, ...(args as []));

      const detection = this.detect(cmd);
      if (!detection.hit) return originalSend(data as never, ...(args as []));

      const stdout = extractStdout(envelope);
      const problemId = extractProblemId(envelope) ?? 'unknown';
      const messageId =
        typeof envelope.id === 'string' || typeof envelope.id === 'number'
          ? String(envelope.id)
          : undefined;

      try {
        ctx.logHit({
          problemId,
          ...(messageId !== undefined ? { messageId } : {}),
          kind: 'write_protection',
          cmd,
          stdout_preview: stdout.slice(0, STDOUT_PREVIEW_LIMIT) || null,
        });
      } catch { /* ignore */ }

      try {
        onsiteBroadcast.broadcast({ type: 'discipline:write-protection-detected' });
      } catch { /* ignore */ }

      const flagged = withDisciplineFlag(envelope, {
        writeOriginalLog: true,
        cmd,
      });
      return originalSend(JSON.stringify(flagged) as never, ...(args as []));
    }) as WebSocket['send'];
  },
};