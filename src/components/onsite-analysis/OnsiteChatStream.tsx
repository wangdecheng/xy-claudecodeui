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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Database, Paperclip, Send, StopCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { OnsiteChatFrame, ProblemRecord } from '@shared/onsite-types';

import { cn } from '../../lib/utils';
import { useOnsiteWebSocket } from '../../contexts/OnsiteWebSocketContext';
import { useOnsiteStore } from '../../stores/onsiteStore';
import type { PendingPermissionRequest } from '../chat/types/types';
import { AskUserQuestionPanel } from '../chat/tools/components/InteractiveRenderers';

import AnalysisFilesRow from './AnalysisFilesRow';
import AnalysisInfoChips from './AnalysisInfoChips';
import CardRenderer from './cards/CardRenderer';
import CwdLockView from './CwdLockView';
import DisciplineCounter from './DisciplineCounter';
import { initialOnsiteRunState, reduceOnsiteRunState } from './onsiteRunState';
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

// stream_end: 内容块边界(flush 累积的 stream_delta)；error: SDK 运行期错误；
// permission_request / permission_cancelled: 交互式工具(AskUserQuestion)
// thinking: 当前无渲染目标(silently dropped)，但仍在集合中避免消费
const ALLOWED_KINDS = new Set(['text', 'tool_use', 'tool_result', 'thinking', 'stream_delta', 'stream_end', 'complete', 'error', 'permission_request', 'permission_cancelled']);

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
  const loadMessages = store.loadMessages;
  const takeInitialPrompt = store.takeInitialPrompt;

  const [messages, setMessages] = useState<OnsiteStreamMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [runState, setRunState] = useState(initialOnsiteRunState);
  const [discipline, setDiscipline] = useState<DisciplineState>({
    softening: 0,
    writeOriginalLog: 0,
    log: [],
  });
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermissionRequest[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // sessionIdRef:初始为 problem.id,收到 session_created 后更新为 UUID。
  // sendDraft / abort 从这里读取,确保首次 run 后 chat.send 用 UUID 发包,
  // 与 CLI --resume 指向同一 session。
  const sessionIdRef = useRef(problemId);
  // problem 切换时重置
  useEffect(() => {
    sessionIdRef.current = problemId;
  }, [problemId]);

  // stream_delta 累积: Claude SDK 实时流不发完整 assistant text,而是连续
  // stream_delta 推送文本片段。这里 accum 到 ref,100ms 批量 flush 一次
  // (与 chat 路径 useChatRealtimeHandlers 保持一致),避免每个 delta 重渲染。
  const accumulatedRef = useRef('');
  const streamTimerRef = useRef<number | null>(null);
  // 稳定的 streaming 消息 id,跨多次 setMessages 复用,防止 React key 漂移
  const streamingMsgIdRef = useRef(`streaming-${Date.now()}`);

  // ─── effects ────────────────────────────────────────────────────────

  // Mount: refresh list + push hello frame with current problem.
  useEffect(() => {
    void loadProblems();
  }, [loadProblems]);

  // Load uploaded/extracted files for the header files-row on problem switch.
  useEffect(() => {
    if (problemId) void loadFiles(problemId);
  }, [problemId, loadFiles]);

  // 切到某个 problem:从 server 端 ring buffer 拉历史消息回放。
  // 修复前 messages 仅来自 WS subscribe,切走后再切回看不到历史。
  // 用 cancelled 标记丢弃过期响应,避免快速切 problem 时旧 fetch 覆盖新 state。
  useEffect(() => {
    if (!problemId) return;
    let cancelled = false;
    void (async () => {
      const stored = await loadMessages(problemId);
      if (cancelled) return;
      if (stored.length === 0) return;
      // 转成 OnsiteStreamMessage,按 ts 正序(API 已正序返回)。
      const replayed: OnsiteStreamMessage[] = stored.map((m) => {
        if (m.kind === 'tool_use' || m.kind === 'tool_result') {
          return {
            id: `srv-${m.problemId}-${m.ts}-${m.kind}`,
            role: 'tool',
            kind: m.kind,
            text: m.content,
            ts: m.ts,
          };
        }
        // text / other 一律当 text 渲染
        return {
          id: `srv-${m.problemId}-${m.ts}-${m.kind}`,
          role: m.role === 'user' ? 'user' : 'assistant',
          kind: 'text',
          text: m.content,
          ts: m.ts,
        };
      });
      setMessages(replayed);
    })();
    return () => {
      cancelled = true;
    };
  }, [problemId, loadMessages]);

  // setHelloContext — when problem 记录就绪时将 cwd 告诉服务器
  useEffect(() => {
    if (problem) {
      setHelloContext(problemId, problem.cwd);
    }
  }, [problemId, problem, setHelloContext]);

  // reset stream on problemId switch(仅路由参数改变,不是 problem 对象引用改变)
  useEffect(() => {
    setMessages([]);
    setDiscipline({ softening: 0, writeOriginalLog: 0, log: [] });
    setDraft('');
    setRunState(initialOnsiteRunState);
    setPendingPermissions([]);
    // 重置流累积状态,防止上一个 problem 的 stream_delta 残余泄漏
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedRef.current = '';
    streamingMsgIdRef.current = `streaming-${Date.now()}`;
  }, [problemId]);

  // Subscribe to WS frames.
  useEffect(() => {
    return subscribe((event) => {
      const ev = event as OnsiteChatFrame;

      // session_created:首次 run 后服务端转发的 UUID,更新 sessionIdRef,
      // 让后续 chat.send/abort 用 UUID 发包,CLI --resume 也指向同一 UUID。
      if (ev.kind === 'session_created') {
        const newId = (ev as Record<string, unknown>).newSessionId as string | undefined
          ?? ev.sessionId;
        if (newId && typeof newId === 'string') {
          sessionIdRef.current = newId;
        }
        return;
      }

      if (ev.kind === 'protocol_error') {
        setRunState((state) => reduceOnsiteRunState(state, { type: 'terminal' }));
        return;
      }

      // ── permission_request / permission_cancelled ──────────────────
      // AskUserQuestion 等交互式工具需要用户响应;复用 chat 路径的
      // AskUserQuestionPanel,通过 pendingPermissions 状态驱动渲染。
      if (ev.kind === 'permission_request') {
        const requestId = (ev as Record<string, unknown>).requestId as string | undefined;
        if (!requestId) return;
        const toolName = ((ev as Record<string, unknown>).toolName as string) || 'UnknownTool';
        // 只处理 AskUserQuestion(ExitPlanMode 当前在 onsite 场景不触发)
        if (toolName !== 'AskUserQuestion') return;
        setPendingPermissions((cur) => {
          if (cur.some((r) => r.requestId === requestId)) return cur;
          return [...cur, {
            requestId,
            toolName,
            input: (ev as Record<string, unknown>).input,
            sessionId: sessionIdRef.current,
            receivedAt: new Date(),
          }];
        });
        return;
      }

      if (ev.kind === 'permission_cancelled') {
        const requestId = (ev as Record<string, unknown>).requestId as string | undefined;
        if (requestId) {
          setPendingPermissions((cur) => cur.filter((r) => r.requestId !== requestId));
        }
        return;
      }

      // Only react to frames tagged for this problem.
      // sessionId 可能已更新为 UUID(sessionIdRef),两条都接受。
      if (ev.sessionId && ev.sessionId !== problemId && ev.sessionId !== sessionIdRef.current) return;
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
      } else if (ev.kind === 'error') {
        // SDK 运行期错误:作为红色 error 气泡渲染,让操作者知道出错了
        setMessages((cur) => [
          ...cur,
          {
            id: makeId(),
            role: 'assistant',
            kind: 'text' as const,
            text: `⚠️ ${content || '未知错误'}`,
            ts,
          },
        ]);
        setRunState((state) => reduceOnsiteRunState(state, { type: 'terminal' }));
      } else if (ev.kind === 'stream_delta' && content) {
        // 实时流文本累积: Claude SDK 不发完整 assistant text,而是连续
        // stream_delta 推送文本片段。用 ref 累积 + 100ms 定时器批量
        // flush(与 chat 路径 useChatRealtimeHandlers 一致),用稳定 id
        // 避免 React 因 key 变化销毁/重建 DOM。
        accumulatedRef.current += content;
        if (!streamTimerRef.current) {
          streamTimerRef.current = window.setTimeout(() => {
            streamTimerRef.current = null;
            const text = accumulatedRef.current;
            setMessages((cur) => {
              const last = cur[cur.length - 1];
              if (last && last.id === streamingMsgIdRef.current) {
                return [...cur.slice(0, -1), { ...last, text, ts: Date.now() }];
              }
              return [
                ...cur,
                {
                  id: streamingMsgIdRef.current,
                  role: 'assistant',
                  kind: 'text' as const,
                  text,
                  ts: Date.now(),
                },
              ];
            });
          }, 100);
        }
      } else if (ev.kind === 'complete') {
        setRunState((state) => reduceOnsiteRunState(state, { type: 'terminal' }));
        // 流结束: 刷新剩余累积文本,重置 accum state
        if (streamTimerRef.current) {
          clearTimeout(streamTimerRef.current);
          streamTimerRef.current = null;
        }
        const remaining = accumulatedRef.current;
        if (remaining) {
          setMessages((cur) => {
            const last = cur[cur.length - 1];
            if (last && last.id === streamingMsgIdRef.current) {
              return [...cur.slice(0, -1), { ...last, text: remaining, ts: Date.now() }];
            }
            return [
              ...cur,
              {
                id: streamingMsgIdRef.current,
                role: 'assistant',
                kind: 'text' as const,
                text: remaining,
                ts: Date.now(),
              },
            ];
          });
        }
        accumulatedRef.current = '';
        streamingMsgIdRef.current = `streaming-${Date.now()}`;
      } else if (ev.kind === 'stream_end') {
        // 内容块边界: flush 但不重置 id(下一个 content block 继续追到
        // 同一 streaming 气泡),与 chat 路径的 stream_end 语义一致。
        if (streamTimerRef.current) {
          clearTimeout(streamTimerRef.current);
          streamTimerRef.current = null;
        }
        const text = accumulatedRef.current;
        if (text) {
          setMessages((cur) => {
            const last = cur[cur.length - 1];
            if (last && last.id === streamingMsgIdRef.current) {
              return [...cur.slice(0, -1), { ...last, text, ts: Date.now() }];
            }
            return [
              ...cur,
              {
                id: streamingMsgIdRef.current,
                role: 'assistant',
                kind: 'text' as const,
                text,
                ts: Date.now(),
              },
            ];
          });
        }
        accumulatedRef.current = '';
      }
      // thinking → silently dropped (no render target yet).
    });
  }, [subscribe, problemId]);

  // Auto-scroll to bottom on new message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // ─── actions ────────────────────────────────────────────────────────

  /**
   * 发送一条文本消息(首轮开场 prompt 与 composer 手敲共用同一通路)。
   * 乐观插入 user 气泡 → 发 chat.send → 按是否被 ws 层接受更新 runState。
   */
  const sendText = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !isConnected) return false;
    setSending(true);
    setMessages((cur) => [
      ...cur,
      { id: makeId(), role: 'user', kind: 'text', text: trimmed, ts: Date.now() },
    ]);
    const accepted = send({ type: 'chat.send', sessionId: sessionIdRef.current, content: trimmed });
    setRunState((state) => reduceOnsiteRunState(
      state,
      { type: accepted ? 'send.accepted' : 'send.rejected' },
    ));
    setSending(false);
    return accepted;
  }, [isConnected, send]);

  // 首轮开场 prompt 自动发送:NewIssueWizard 创建问题后会把客户/迭代/数据库/
  // 问题描述组装成的 prompt 预置到 store。本组件 mount + WS 就绪后若发现自己
  // problemId 有 pending,自动发一帧并 take 清掉,避免重复发送。
  // 必须等 isConnected:true 才发——否则 send 返回 false,prompt 仍留在 store,
  // 等 WS 重连后本 effect 重跑(isConnected 进 deps)再发。
  useEffect(() => {
    if (!problemId || !isConnected) return;
    const prompt = takeInitialPrompt(problemId);
    if (!prompt) return;
    sendText(prompt);
  }, [problemId, isConnected, takeInitialPrompt, sendText]);

  const sendDraft = () => {
    const text = draft.trim();
    if (!text || !isConnected) return;
    if (sendText(text)) {
      setDraft('');
    }
  };

  const abort = () => {
    setRunState((state) => reduceOnsiteRunState(state, { type: 'abort.requested' }));
    send({ type: 'chat.abort', sessionId: sessionIdRef.current });
  };

  // 交互式工具(AskUserQuestion)的权限决策回调,复用 chat 路径的
  // chat.permission-response 协议。
  const handlePermissionDecision = useCallback(
    (requestIds: string | string[], decision: { allow?: boolean; message?: string; updatedInput?: unknown }) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      setPendingPermissions((cur) => cur.filter((r) => !ids.includes(r.requestId)));
      for (const requestId of ids) {
        send({
          type: 'chat.permission-response',
          requestId,
          allow: decision.allow ?? true,
          updatedInput: decision.updatedInput,
          message: decision.message,
        });
      }
    },
    [send],
  );

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
        className="flex shrink-0 flex-col gap-2 border-b border-border bg-card/50 px-4 py-2"
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
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3"
      >
        {messages.length > 0 &&
          messages.map((m) => (
            <MessageBubble key={m.id} message={m} onRerun={insertIntoDraft} />
          ))}
      </div>

      <footer className="flex shrink-0 flex-col gap-1 border-t border-border bg-card/50 px-4 py-2">
        {/* 交互式工具面板——AskUserQuestion 等权限请求在此渲染 */}
        {pendingPermissions.length > 0 && (
          <div className="mb-2 space-y-2">
            {pendingPermissions.map((req) => {
              if (req.toolName === 'AskUserQuestion') {
                return (
                  <AskUserQuestionPanel
                    key={req.requestId}
                    request={req}
                    onDecision={handlePermissionDecision}
                  />
                );
              }
              return null;
            })}
          </div>
        )}
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
            disabled={!isConnected || draft.trim().length === 0 || sending || runState.isProcessing}
            data-testid="onsite-chat-send"
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" />
            发送
          </button>
          <button
            type="button"
            onClick={abort}
            disabled={!isConnected || !runState.isProcessing}
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
    if (isAssistant) return 'mr-auto max-w-[80%] whitespace-pre-wrap rounded-2xl bg-card border border-border px-3 py-2 text-sm text-foreground shadow-sm';
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
