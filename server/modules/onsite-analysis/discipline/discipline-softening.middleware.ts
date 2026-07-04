/**
 * discipline-softening.middleware — 软化词扫描纪律审计。
 *
 * Spec:specs/discipline-trace-id.md REQ-8.x + design.md §D-7.2
 *
 * 设计:
 *  - 词库从 config/discipline-words.json 懒加载(避免循环依赖,便于测试覆盖)
 *  - findWords / containsSoftening / replaceForUi 是**纯函数**,独立测
 *  - attachToWs(ws, ctx) 包装 ws.send,只对 ws.kind === 'onsite' 的 ws 生效
 *  - 命中 → 落 onsite_discipline_log(kind=softening) + 给 envelope 加 discipline.softening flag
 *  - **不改 content** — 替换/高亮由 UI 在收到 discipline flag 后用 replaceForUi 渲染
 *
 * 注意:Task 4.3 (confirm-root-cause) 会直接调用 containsSoftening 拦截根因结论,
 * 所以这块的纯函数必须稳定且与 UI 渲染一致。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { WebSocket } from 'ws';

type DisciplineKind = 'softening';

export type SofteningMatch = { word: string; position: number };

export type SofteningLogEntry = {
  problemId: string;
  messageId?: string;
  word: string;
  position: number;
  kind: DisciplineKind;
};

export type DisciplineContext = {
  enabledFor: (ws: WebSocket) => boolean;
  logHit: (entry: SofteningLogEntry) => void;
};

// 用 process.cwd() 解析,这样无论编译/运行位置在哪里,只要从仓库根启动都正确。
// 路径: <cwd>/config/discipline-words.json
function resolveWordsPath(): string {
  return path.resolve(process.cwd(), 'config/discipline-words.json');
}

let cachedWords: string[] | null = null;

function loadWords(): string[] {
  if (cachedWords !== null) return cachedWords;
  const raw = fs.readFileSync(resolveWordsPath(), 'utf8');
  const parsed = JSON.parse(raw) as { words?: unknown };
  const words = Array.isArray(parsed.words)
    ? (parsed.words as unknown[]).filter((w): w is string => typeof w === 'string')
    : [];
  cachedWords = words;
  return words;
}

/**
 * 测试 escape hatch — 替换内存词库(避免污染 fs)
 */
export function _setWordsForTests(words: string[] | null): void {
  cachedWords = words;
}

/**
 * Pure: 在文本中找出所有软化词命中,返回 [{ word, position }, ...]
 * 位置按从左到右排序,词不可重叠(取第一个命中后从结尾跳过)。
 */
function findWordsPure(text: string, words: string[]): SofteningMatch[] {
  const matches: SofteningMatch[] = [];
  for (const word of words) {
    let fromIndex = 0;
    while (fromIndex <= text.length) {
      const idx = text.indexOf(word, fromIndex);
      if (idx < 0) break;
      matches.push({ word, position: idx });
      fromIndex = idx + word.length;
    }
  }
  matches.sort((a, b) => a.position - b.position);
  return matches;
}

/**
 * Pure: 把命中词替换为 `<softening word="X" position="N"/>原词`,
 * 非命中词保留。UI 拿到这个版本后,可直接显示高亮。
 */
function replaceForUiPure(text: string, words: string[]): string {
  const matches = findWordsPure(text, words);
  if (matches.length === 0) return text;
  // 从后往前 replace,避免位置漂移
  let out = text;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const m = matches[i]!;
    const before = out.slice(0, m.position);
    const after = out.slice(m.position + m.word.length);
    out = `${before}<softening word="${m.word}" position="${m.position}"/>${m.word}${after}`;
  }
  return out;
}

/**
 * 解析 incoming/outgoing WS frame 的辅助 — 允许乱序字段、缺失字段。
 */
function safeParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 从 envelope 中提取 problemId(若存在)
 * - 优先 envelope.problemId
 * - 其次 envelope.sessionId(在 onsite 路径中 sessionId 即 problemId)
 */
function extractProblemId(envelope: Record<string, unknown>): string | null {
  if (typeof envelope.problemId === 'string' && envelope.problemId.length > 0) {
    return envelope.problemId;
  }
  if (typeof envelope.sessionId === 'string' && envelope.sessionId.length > 0) {
    return envelope.sessionId;
  }
  return null;
}

/**
 * 从 envelope 中提取 content 字符串(若存在)
 */
function extractContent(envelope: Record<string, unknown>): string | null {
  const c = envelope.content;
  if (typeof c === 'string') return c;
  // 部分 gateway envelope 用 delta/text 字段
  if (typeof envelope.text === 'string') return envelope.text;
  return null;
}

/**
 * 把 discipline flag 注入到 envelope 的 outbound 副本(不动 input)
 */
function withDisciplineFlag(
  envelope: Record<string, unknown>,
  matches: SofteningMatch[],
): Record<string, unknown> {
  return {
    ...envelope,
    discipline: {
      ...((envelope.discipline as Record<string, unknown> | undefined) ?? {}),
      softening: true,
      words: matches.map((m) => ({ word: m.word, position: m.position })),
    },
  };
}

export const disciplineSofteningMiddleware = {
  /**
   * Pure — 给定文本,返回所有软化词命中。
   */
  findWords(text: string): SofteningMatch[] {
    return findWordsPure(text, loadWords());
  },

  /**
   * Pure — 是否有软化词。
   */
  containsSoftening(text: string): boolean {
    return this.findWords(text).length > 0;
  },

  /**
   * Pure — UI 渲染辅助:把命中词包成 `<softening word="X" position="N"/>原词`
   */
  replaceForUi(text: string): string {
    return replaceForUiPure(text, loadWords());
  },

  /**
   * 包装 ws.send:只对 ws.kind === 'onsite' 的 ws 生效。
   * - 命中软化词 → 落日志 + envelope 加 discipline.softening flag
   * - 不改 content
   */
  attachToWs(ws: WebSocket, ctx: DisciplineContext): void {
    if (!ctx.enabledFor(ws)) {
      return; // chat 路径不挂
    }

    const originalSend = ws.send.bind(ws);

    ws.send = ((data: unknown, ...args: unknown[]) => {
      // 1) 仅处理 string frame(buffer 二进制暂忽略)
      if (typeof data !== 'string') {
        return originalSend(data as never, ...(args as []));
      }

      const envelope = safeParse(data);
      if (!envelope) {
        return originalSend(data as never, ...(args as []));
      }

      const content = extractContent(envelope);
      if (content === null) {
        return originalSend(data as never, ...(args as []));
      }

      const matches = findWordsPure(content, loadWords());
      if (matches.length === 0) {
        return originalSend(data as never, ...(args as []));
      }

      // 2) 落日志(对每个命中都记一条,便于 UI 统计)
      const problemId = extractProblemId(envelope);
      const messageId =
        typeof envelope.id === 'string' || typeof envelope.id === 'number'
          ? String(envelope.id)
          : typeof envelope.messageId === 'string' || typeof envelope.messageId === 'number'
            ? String(envelope.messageId)
            : undefined;

      if (problemId) {
        for (const m of matches) {
          try {
            ctx.logHit({
              problemId,
              ...(messageId !== undefined ? { messageId } : {}),
              word: m.word,
              position: m.position,
              kind: 'softening',
            });
          } catch {
            /* 日志落库失败不应阻塞发送 */
          }
        }
      }

      // 3) envelope 加 flag 后再发
      const flagged = withDisciplineFlag(envelope, matches);
      return originalSend(JSON.stringify(flagged) as never, ...(args as []));
    }) as WebSocket['send'];
  },
};