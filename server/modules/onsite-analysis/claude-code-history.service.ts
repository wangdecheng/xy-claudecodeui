/**
 * claude-code-history.service — 从本地 Claude Code CLI 的 session JSONL
 * 文件回放该 problem 的历史消息。
 *
 * 背景:
 *  - onsite messagesStore 是纯内存 ring buffer,只捕获经 OnsiteChatStream
 *    UI 走的 ws.send。若用户直接用 `claude` CLI 在 problem.cwd 下对话,
 *    那些消息不会进 messagesStore,UI 切回就看不到。
 *  - Claude Code CLI 把 session 写到
 *    ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *    每行一个 JSON,type ∈ {user, assistant, ...}。
 *  - 同一项目下多个 session 共享一个 project 目录,无法精确判定哪条
 *    消息属于哪个 problem。启发式:
 *      1) timestamp >= problem.created_at
 *      2) 若 user 消息内容包含 problem.cwd 的 basename(slug),优先保留
 *  - 错误一律吞掉,返回空数组 — 读盘失败不应该让 GET /messages 500。
 *
 * Spec: REQ-onite-history-replay
 */

import { promises as fs, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { StoredMessage } from './messages-store.service.js';

const DEFAULT_CLAUDE_HOME = path.join(os.homedir(), '.claude', 'projects');
const MAX_MESSAGES = 500;

interface RawJsonlLine {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  timestamp?: string;
  uuid?: string;
  sessionId?: string;
  cwd?: string;
}

function encodeProjectPath(cwd: string): string {
  // 与 Claude Code 磁盘目录命名一致:把所有「非字母数字且非 -」的字符
  // 替换为 -(参考 server/index.js 中 encodedPath 的同一规则)。
  // 关键:`/` 与非 ASCII 字符(如中文 problem 目录名「不涉及三方对接」)
  // 都会被替换成 -,因此 /Users/.../20260707-不涉及三方对接
  // → -Users-...-20260707--------
  // 旧实现只 replace(/\//g, '-') 会保留中文,与真实磁盘目录对不上,
  // 导致含中文的 onsite problem 永远扫不到 JSONL、历史加载为空。
  return cwd.replace(/[^a-zA-Z0-9-]/g, '-');
}

function basenameSlug(cwd: string): string {
  // /Users/.../20260703-zhongche → 20260703-zhongche
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function normalizeCwd(cwd: string): string {
  return path.resolve(cwd);
}

function isUserTextLine(line: RawJsonlLine): string | null {
  if (line.type !== 'user') return null;
  const c = line.message?.content;
  if (typeof c === 'string' && c.trim().length > 0) return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const block of c) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string' && text.trim().length > 0) {
          parts.push(text);
        }
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return null;
}

function assistantTextBlocks(line: RawJsonlLine): string[] {
  if (line.type !== 'assistant') return [];
  const c = line.message?.content;
  if (!Array.isArray(c)) return [];
  const out: string[] = [];
  for (const block of c) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim().length > 0) {
        out.push(text);
      }
    }
  }
  return out;
}

function lineTimestamp(line: RawJsonlLine): number {
  if (typeof line.timestamp !== 'string') return 0;
  const t = Date.parse(line.timestamp);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 单行 → 是否属于「锚定」锚:user 消息文本里包含 cwdSlug。
 * 这是判断一个 JSONL 文件(或其中一段)是否属于本 problem 的关键信号,
 * 因为同一 Claude project 目录下会同时存在多个 problem 的 session 文件。
 */
function lineAnchorsProblem(line: RawJsonlLine, cwdSlug: string, problemCwd: string): boolean {
  if (problemCwd && typeof line.cwd === 'string') {
    if (normalizeCwd(line.cwd) === normalizeCwd(problemCwd)) return true;
  }
  if (!cwdSlug) return true; // 没传 slug 时不过滤(兼容旧调用)
  const text = isUserTextLine(line);
  if (!text) return false;
  return text.includes(cwdSlug);
}

/**
 * 解析单个 JSONL 文件,产出 StoredMessage[]。跳过空/坏行。
 * 已知限制:不展开 thinking / tool_use / tool_result — 它们对 v1 的
 * UI 重放无价值(text 块就够展示「Claude 说了啥」)。
 *
 * 过滤规则(组合):
 *  1. timestamp < createdAtMs → 丢弃
 *  2. 当 cwdSlug 非空时,本文件必须至少有 1 行「user 文本包含 slug」
 *     才保留(否则整文件跳过)—— 这是跨 problem 隔离的关键,
 *     解决「新建问题后回放 100+ 条其他 problem 的消息」的 bug。
 */
export function parseJsonlToMessages(
  content: string,
  problemId: string,
  createdAtMs: number,
  cwdSlug: string,
  problemCwd: string = '',
): StoredMessage[] {
  const lines = content.split('\n');
  const parsed: RawJsonlLine[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      parsed.push(JSON.parse(trimmed) as RawJsonlLine);
    } catch {
      continue;
    }
  }
  // cwdSlug 非空时,先做「整文件是否锚定」判定,避免在多 problem 共享 project
  // 目录的情况下把所有 session 的消息都喂给本 problem。
  if ((cwdSlug || problemCwd) && !parsed.some((l) => lineAnchorsProblem(l, cwdSlug, problemCwd))) {
    return [];
  }

  const out: StoredMessage[] = [];
  for (const line of parsed) {
    const ts = lineTimestamp(line);
    if (ts === 0) continue;
    if (ts < createdAtMs) continue;

    if (line.type === 'user') {
      const text = isUserTextLine(line);
      if (text) {
        out.push({
          problemId,
          role: 'user',
          kind: 'text',
          content: text,
          ts,
        });
      }
    } else if (line.type === 'assistant') {
      for (const text of assistantTextBlocks(line)) {
        out.push({
          problemId,
          role: 'assistant',
          kind: 'text',
          content: text,
          ts,
        });
      }
    }
  }
  return out;
}

/**
 * 找到 problem.cwd 对应的 Claude Code project 目录下的所有 .jsonl 文件。
 * 失败(目录不存在/无权限)→ 返回空数组,调用方继续。
 */
function listJsonlFilesForCwd(cwd: string, claudeHome: string): string[] {
  const projectDir = path.join(claudeHome, encodeProjectPath(cwd));
  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(projectDir, name));
}

function listProjectJsonlFiles(problemCwd: string, claudeHome: string): string[] {
  const candidates = [
    problemCwd,
    path.dirname(problemCwd),
  ];
  const files = new Set<string>();
  for (const cwd of candidates) {
    for (const file of listJsonlFilesForCwd(cwd, claudeHome)) {
      files.add(file);
    }
  }
  return [...files];
}

/**
 * 加载该 problem 的历史消息。
 *
 * @param problemId  Onsite problem id(回填到 StoredMessage.problemId)
 * @param problemCwd problem 的工作目录(用于定位 Claude project 目录)
 * @param createdAtMs  problem.created_at 的毫秒数(用于时间过滤)
 * @param claudeHome  可选 — 注入 ~/.claude/projects 根,测试用;默认读 os.homedir
 * @returns StoredMessage[] — 按 ts 升序,最多 MAX_MESSAGES 条
 */
export async function loadHistoryFromClaudeCode(
  problemId: string,
  problemCwd: string,
  createdAtMs: number,
  claudeHome: string = DEFAULT_CLAUDE_HOME,
): Promise<StoredMessage[]> {
  const slug = basenameSlug(problemCwd);
  const files = listProjectJsonlFiles(problemCwd, claudeHome);
  if (files.length === 0) return [];

  const all: StoredMessage[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await fs.readFile(file, 'utf-8');
    } catch {
      continue;
    }
    const msgs = parseJsonlToMessages(content, problemId, createdAtMs, slug, problemCwd);
    all.push(...msgs);
  }

  // 按 ts 升序
  all.sort((a, b) => a.ts - b.ts);

  // Cap
  if (all.length > MAX_MESSAGES) {
    return all.slice(all.length - MAX_MESSAGES);
  }
  return all;
}
