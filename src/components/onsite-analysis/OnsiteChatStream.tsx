/**
 * OnsiteChatStream — chat panel for one problem.
 *
 * Behavior:
 *  - on mount:
 *      * setHelloContext(problemId, problem.cwd) so the server picks
 *        up the right problemId/cwd on the next message.
 *      * loadProblems() so the StatusBadge reflects the latest state.
 *      * subscribe to WS frames; filter to event.sessionId === problemId
 *        and the {text, tool_use, tool_result, thinking, stream_delta,
 *        complete} kinds.
 *  - user messages → right-aligned blue bubble (`.msg.user`).
 *  - assistant text → left-aligned plain text + CardRenderer for any
 *    `<card type="...">` tags.
 *  - tool_use / tool_result → indented gray row.
 *  - discipline.softening / discipline.writeOriginalLog envelopes bump
 *    the DisciplineCounter.
 *
 * The stream is a self-contained client-side state machine — there's
 * no GET /messages endpoint in Batch 7, so the operator must keep the
 * panel open for the session. (Persistence is out of scope.)
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, Paperclip, Send, StopCircle } from 'lucide-react';

import type { OnsiteChatFrame, ProblemRecord } from '@shared/onsite-types';

import { cn } from '../../lib/utils';
import { useOnsiteStore } from '../../stores/onsiteStore';
import { useOnsiteWebSocket } from '../../contexts/OnsiteWebSocketContext';
import AnalysisFilesRow from './AnalysisFilesRow';
import AnalysisInfoChips from './AnalysisInfoChips';
import CardRenderer from './cards/CardRenderer';
import CwdLockView from './CwdLockView';
import DisciplineCounter from './DisciplineCounter';
import { sqlTemplateFor } from './sqlTemplates';
import StatusBadge from './StatusBadge';

// ─── Stream message model ────────────────────────────────────────────────

export type OnsiteStreamMessage =
  | { id: string; role: 'user'; kind: 'text'; text: string; ts: number }
  | { id: string; role: 'assistant'; kind: 'text'; text: string; ts: number; softening?: boolean }
  | { id: string; role: 'tool'; kind: 'tool_use' | 'tool_result'; name?: string; text: string; ts: number };

interface DisciplineLogEntry {
  ts: number;
  word: string;
  kind: 'softening' | 'writeOriginalLog' | 'traceIdSuspect';
}

interface DisciplineState {
  softening: number;
  writeOriginalLog: number;
  log: DisciplineLogEntry[];
}

const ALLOWED_KINDS = new Set(['text', 'tool_use', 'tool_result', 'thinking', 'stream_delta', 'complete']);

function makeId(): string {
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface OnsiteChatStreamProps {
  problemId: string;
}

export default function OnsiteChatStream({ problemId }: OnsiteChatStreamProps) {
  const { t } = useTranslation(['onsite', 'common']);
  const store = useOnsiteStore();
  const getProblem = store.getProblem;
  const loadProblems = store.loadProblems;
  const loadFiles = store.loadFiles;
  const uploadFiles = store.uploadFiles;
  const setHelloContext = useOnsiteWebSocket().setHelloContext;
  const send = useOnsiteWebSocket().send;
  const subscribe = useOnsiteWebSocket().subscribe;
  const isConnected = useOnsiteWebSocket().isConnected;

  const problem: ProblemRecord | undefined = getProblem(problemId);
  const files = store.getFiles(problemId);

  const [messages, setMessages] = useState<OnsiteStreamMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [discipline, setDiscipline] = useState<DisciplineState>({
    softening: 0,
    writeOriginalLog: 0,
    log: [],
  });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ─── effects ────────────────────────────────────────────────────────

  // Mount: refresh list + push hello frame with current problem.
  useEffect(() => {
    void loadProblems();
  }, [loadProblems]);

  // Load uploaded/extracted files for the header files-row on problem switch.
  useEffect(() => {
    if (problemId) void loadFiles(problemId);
  }, [problemId, loadFiles]);

  useEffect(() => {
    if (problem) {
      setHelloContext(problemId, problem.cwd);
    }
    // reset stream on problem switch
    setMessages([]);
    setDiscipline({ softening: 0, writeOriginalLog: 0, log: [] });
    setDraft('');
  }, [problemId, problem, setHelloContext]);

  // Subscribe to WS frames.
  useEffect(() => {
    return subscribe((event) => {
      const ev = event as OnsiteChatFrame;

      // Only react to frames tagged for this problem.
      if (ev.sessionId && ev.sessionId !== problemId) return;
      // If sessionId is missing, treat it as "for current problem" — the
      // server only allows one hello per WS so the only other sessionId
      // we'd see is the active problem's.

      // Discipline tally — single source of truth lives here and flows to
      // <DisciplineCounter> via props.
      if (ev.discipline) {
        const d = ev.discipline;
        setDiscipline((cur) => {
          const softening = cur.softening + (d.softening === true ? 1 : 0);
          const writeOriginalLog = cur.writeOriginalLog + (d.writeOriginalLog === true ? 1 : 0);
          const ts = Date.now();
          const append: DisciplineLogEntry[] = [];
          if (d.softening === true) {
            const word = d.words?.[0]?.word ?? '';
            append.push({
              ts,
              word,
              kind: 'softening',
            });
          }
          if (d.writeOriginalLog === true) {
            append.push({
              ts,
              word: d.cmd ?? '',
              kind: 'writeOriginalLog',
            });
          }
          return {
            softening,
            writeOriginalLog,
            log: [...cur.log, ...append],
          };
        });
        // Softening renders inline via card/cardRenderer
        if (d.softening === true && ev.kind === 'text' && ev.role === 'assistant') {
          setMessages((cur) => {
            // Try to find the last assistant text and tag it
            for (let i = cur.length - 1; i >= 0; i -= 1) {
              const m = cur[i];
              if (m && m.kind === 'text' && m.role === 'assistant') {
                return [...cur];
              }
            }
            return cur;
          });
        }
      }

      if (typeof ev.kind !== 'string') return;
      if (!ALLOWED_KINDS.has(ev.kind)) return;

      const ts = Date.now();
      const content = ev.content ?? '';

      if (ev.kind === 'text') {
        const role = ev.role === 'user' ? 'user' : 'assistant';
        setMessages((cur) => [
          ...cur,
          {
            id: makeId(),
            role,
            kind: 'text',
            text: content,
            ts,
          },
        ]);
      } else if (ev.kind === 'tool_use' || ev.kind === 'tool_result') {
        setMessages((cur) => [
          ...cur,
          {
            id: makeId(),
            role: 'tool',
            kind: ev.kind as 'tool_use' | 'tool_result',
            ...(typeof ev.name === 'string' ? { name: ev.name } : {}),
            text: content,
            ts,
          },
        ]);
      }
      // thinking / stream_delta / complete → handled silently for Batch 7.
    });
  }, [subscribe, problemId]);

  // Auto-scroll to bottom on new message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // ─── actions ────────────────────────────────────────────────────────

  const sendDraft = () => {
    const text = draft.trim();
    if (!text || !isConnected) return;
    setSending(true);
    // Optimistic user message.
    setMessages((cur) => [
      ...cur,
      { id: makeId(), role: 'user', kind: 'text', text, ts: Date.now() },
    ]);
    // Reuse chat.send envelope (server already routes this through the
    // onsite WS once ws.kind === 'onsite' is set on the socket).
    send({ type: 'chat.send', sessionId: problemId, content: text });
    setDraft('');
    setSending(false);
  };

  const abort = () => {
    send({ type: 'chat.abort', sessionId: problemId });
  };

  // Insert text into the composer draft and focus it (used by SQL template
  // button and card "补日志重跑" action).
  const insertIntoDraft = (text: string) => {
    setDraft((cur) => (cur.trim() ? `${cur}\n${text}` : text));
    // focus after state flush
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files ? Array.from(e.target.files) : [];
    // reset input so the same file can be re-picked later
    e.target.value = '';
    if (picked.length === 0) return;
    await uploadFiles(problemId, picked);
    await loadFiles(problemId);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendDraft();
    }
  };

  // ─── render ─────────────────────────────────────────────────────────

  if (!problem) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-dashed border-border bg-card p-6 text-center">
          <h2 className="text-sm font-semibold">Loading problem {problemId}…</h2>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="onsite-chat-stream" className="flex h-full flex-col">
      <header
        data-testid="onsite-chat-header"
        className="flex flex-col gap-2 border-b border-border bg-card/50 px-4 py-2"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="onsite-chat-title" className="text-sm font-semibold text-foreground">
            {problem.customer}
          </span>
          {problem.description && (
            <span
              data-testid="onsite-chat-description"
              className="max-w-[60%] truncate text-xs text-muted-foreground"
              title={problem.description}
            >
              · {problem.description}
            </span>
          )}
          <StatusBadge status={problem.status} />
          <div className="ml-auto flex items-center gap-2">
            <CwdLockView cwd={problem.cwd} />
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]',
                isConnected ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
              )}
              data-testid="onsite-ws-status"
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', isConnected ? 'bg-green-500' : 'bg-gray-400')} />
              {isConnected ? 'connected' : 'offline'}
            </span>
            <DisciplineCounter
              softening={discipline.softening}
              writeOriginalLog={discipline.writeOriginalLog}
              log={discipline.log}
            />
          </div>
        </div>
        <AnalysisInfoChips problem={problem} />
        <AnalysisFilesRow files={files} />
      </header>

      <div
        ref={scrollRef}
        data-testid="onsite-chat-scroll"
        className="flex-1 space-y-2 overflow-y-auto px-4 py-3"
      >
        {messages.length > 0 &&
          messages.map((m) => (
            <MessageBubble key={m.id} message={m} onRerun={insertIntoDraft} />
          ))}
      </div>

      <footer className="flex flex-col gap-1 border-t border-border bg-card/50 px-4 py-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          data-testid="onsite-chat-file-input"
          onChange={onPickFiles}
        />
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="上传日志包"
            data-testid="onsite-chat-upload"
            className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-input bg-background text-foreground hover:bg-muted"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => insertIntoDraft(sqlTemplateFor(problem.database))}
            title="插入 SQL 模板"
            data-testid="onsite-chat-sql-template"
            className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-input bg-background text-foreground hover:bg-muted"
          >
            <Database className="h-4 w-4" />
          </button>
          <textarea
            ref={textareaRef}
            data-testid="onsite-chat-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('onsite:chat.placeholder', {
              defaultValue: '补充信息、粘贴日志片段,或让 Claude 继续下一步取证…',
            })}
            rows={2}
            className="flex-1 resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="button"
            onClick={sendDraft}
            disabled={!isConnected || draft.trim().length === 0 || sending}
            data-testid="onsite-chat-send"
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" />
            发送
          </button>
          <button
            type="button"
            onClick={abort}
            disabled={!isConnected}
            data-testid="onsite-chat-abort"
            className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <StopCircle className="h-3.5 w-3.5" />
            停止
          </button>
        </div>
        <p
          data-testid="onsite-composer-hint"
          className="text-center text-[11px] text-muted-foreground"
        >
          {t('onsite:chat.composerHint', {
            cwd: problem.cwd,
            defaultValue: `仅对接 Claude Code · 工作目录锁定在 ${problem.cwd}`,
          })}
        </p>
      </footer>
    </div>
  );
}

function MessageBubble({
  message,
  onRerun,
}: {
  message: OnsiteStreamMessage;
  onRerun?: (hint: string) => void;
}) {
  const isUser = message.kind === 'text' && message.role === 'user';
  const isAssistant = message.kind === 'text' && message.role === 'assistant';
  const isTool = message.kind === 'tool_use' || message.kind === 'tool_result';

  const baseCls = useMemo(() => {
    if (isUser) return 'ml-auto max-w-[80%] rounded-2xl bg-blue-500 px-3 py-2 text-sm text-white shadow-sm';
    if (isAssistant) return 'mr-auto max-w-[80%] whitespace-pre-wrap text-sm text-foreground';
    return 'ml-6 mr-6 rounded-md bg-muted/50 px-2 py-1 font-mono text-[11px] text-muted-foreground';
  }, [isUser, isAssistant]);

  // msg-role 行(REQ-4.6):用户「现场反馈」/AI「Claude · 取证顺序:日志 → 源码 → DB」
  const { t } = useTranslation(['onsite']);
  const roleLabel = isUser
    ? t('onsite:chat.userRole', { defaultValue: '现场反馈' })
    : isAssistant
      ? t('onsite:chat.assistantRole', { defaultValue: 'Claude · 取证顺序:日志 → 源码 → DB' })
      : null;

  return (
    <div
      data-testid={`onsite-msg-${message.role}-${message.kind}`}
      className={cn(
        'flex gap-2',
        isUser ? 'flex-row-reverse self-end' : 'self-start',
      )}
    >
      {/* 头像(REQ-4.5):用户「我」灰底右对齐 / AI「C」Claude 橙底左对齐 */}
      <div
        data-testid={`onsite-avatar-${isUser ? 'user' : isAssistant ? 'ai' : 'tool'}`}
        className={cn(
          'flex h-[30px] w-[30px] flex-shrink-0 select-none items-center justify-center rounded-lg text-xs font-bold',
          isUser && 'bg-secondary text-foreground',
          isAssistant && 'bg-[hsl(14_55%_55%)] text-white',
          isTool && 'bg-muted text-muted-foreground',
        )}
      >
        {isUser ? '我' : isAssistant ? 'C' : '·'}
      </div>

      <div className={cn('flex min-w-0 flex-col', isUser ? 'items-end' : 'items-start')}>
        {roleLabel && (
          <span
            data-testid="onsite-msg-role"
            className={cn(
              'mb-1 text-xs font-semibold text-muted-foreground',
              isUser && 'text-right',
            )}
          >
            {roleLabel}
          </span>
        )}
        {isAssistant ? (
          <div className={baseCls}>
            <CardRenderer text={message.text} {...(onRerun ? { onRerun } : {})} />
          </div>
        ) : (
          <div className={baseCls}>{message.text}</div>
        )}
      </div>
    </div>
  );
}