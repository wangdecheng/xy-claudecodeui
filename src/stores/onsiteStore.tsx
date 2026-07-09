/**
 * onsiteStore — client-side state for the Customer Onsite Analysis feature.
 *
 * Contract note: tasks.md / execution-contract.md describe this as a
 * "zustand store", but the repo has no zustand dependency and §依赖约束
 * forbids adding one. We therefore implement the same observable-store
 * semantics using React hooks (matching `useSessionStore.ts`), so consumers
 * call `useOnsiteStore()` and get back `{ state, actions }` with re-render
 * on change. The exported `useOnsiteStore` shape satisfies the contract
 * acceptance ("actions: loadConfig / loadProblems / selectProblem /
 * patchStatus / uploadFiles + selectors").
 *
 * State layout:
 *   - problems       — list from GET /api/onsite/problems
 *   - config         — cached ConfigPayload from GET /api/onsite/config
 *   - currentProblemId — id of the problem currently selected in the UI
 *   - uploading      — { [problemId]: number } upload progress 0..100
 *   - lastError      — last fetch/upload error message, cleared on next success
 *
 * Why `useRef` + `setTick` (and not useState on the whole object): the
 * store is large enough that pulling it through useState would cause every
 * consumer to re-render on every action. Same pattern as useSessionStore.
 */

/** 单条历史消息(与 server messagesStore.StoredMessage 同构)。 */
export interface OnsiteStoredMessage {
  problemId: string;
  role: 'user' | 'assistant';
  kind: 'text' | 'tool_use' | 'tool_result' | 'other';
  content: string;
  ts: number;
}

import { useCallback, useEffect, useMemo, useState } from 'react';

import { authenticatedFetch } from '../utils/api';

import type {
  ConfigPayload,
  OnsiteFile,
  ProblemListItem,
  ProblemRecord,
  ProblemStatus,
  UploadResult,
} from '@shared/onsite-types';

export interface OnsiteStoreState {
  problems: ProblemListItem[];
  config: ConfigPayload | null;
  currentProblemId: string | null;
  /** Progress 0..100 keyed by problemId; missing key = idle. */
  uploading: Record<string, number>;
  /** Uploaded/extracted files keyed by problemId; from GET /problems/:id/files. */
  files: Record<string, OnsiteFile[]>;
  /**
   * 首轮开场 prompt,按 problemId 单次存放。
   * NewIssueWizard 创建问题后把 wizard 收集的客户/迭代/数据库/问题描述
   * 组装成一段 prompt 塞进来,OnsiteChatStream mount 后若发现自己 problemId
   * 有 pending 就自动发一帧 chat.send,发完立刻 take 清掉,避免重复发送。
   */
  pendingInitialPrompt: Record<string, string>;
  lastError: string | null;
  lastFetchedAt: number;
}

export interface OnsiteStoreActions {
  /** GET /api/onsite/config and cache in store. */
  loadConfig: () => Promise<ConfigPayload | null>;
  /** GET /api/onsite/problems and replace `problems` in store. */
  loadProblems: () => Promise<ProblemListItem[]>;
  /**
   * Set the current problem id (drives `<OnsiteLayout />` selection).
   * Idempotent — re-selecting the same id is a no-op.
   */
  selectProblem: (id: string | null) => void;
  /**
   * 为指定 problem 预置一段首轮开场 prompt(NewIssueWizard 创建问题后调用)。
   * OnsiteChatStream mount 后若该 problem 有 pending,会自动发一帧 chat.send
   * 并通过 takeInitialPrompt 清掉,避免重复发送。
   */
  setInitialPrompt: (id: string, prompt: string) => void;
  /**
   * 取走(并删除)指定 problem 的首轮 prompt。OnsiteChatStream 发完首轮后调用,
   * 保证只发一次——页面刷新/重挂载后不会再发。
   */
  takeInitialPrompt: (id: string) => string | null;
  /** PATCH /api/onsite/problems/:id with new status + reason. */
  patchStatus: (id: string, to: ProblemStatus, reason: string) => Promise<ProblemRecord | null>;
  /**
   * POST /api/onsite/problems/:id/files as multipart/form-data. Updates
   * `uploading[problemId]` as it goes (0..100). Throws on hard failure
   * (network / 4xx non-207); 207 multi-status responses resolve to the
   * per-file results array.
   */
  uploadFiles: (id: string, files: File[]) => Promise<UploadResult[]>;
  /** GET /api/onsite/problems/:id/files and cache in `files[id]`. */
  loadFiles: (id: string) => Promise<OnsiteFile[]>;
  /**
   * GET /api/onsite/problems/:id/messages — 拉该 problem 的 server 端
   * ring buffer 历史消息(最多 500 条,正序)。不缓存到 store,直接返回,
   * 由 OnsiteChatStream 自己 merge 到本地 messages state。
   * 404(unknown problem)→ 返回空数组,不做错误 toast。
   */
  loadMessages: (id: string) => Promise<OnsiteStoredMessage[]>;
  /**
   * DELETE /api/onsite/problems/:id - 物理删除一条 problem(磁盘目录 + DB
   * 含级联子表 + 内存 ring buffer)。成功后本地移除该条、清
   * files/uploading/pendingInitialPrompt 缓存,若删的是当前选中则清空
   * currentProblemId。返回是否成功(失败时写 lastError)。
   */
  deleteProblem: (id: string) => Promise<boolean>;
}

export interface OnsiteStoreSelectors {
  /** Pick the problem matching `id` (returns undefined if absent). */
  getProblem: (id: string | null) => ProblemRecord | undefined;
  /** Pick the upload progress (0..100) for one problem; -1 if not uploading. */
  getUploadProgress: (id: string) => number;
  /** True iff any problem currently has uploading[id] defined. */
  getAnyUploading: () => boolean;
  /** Uploaded/extracted files for one problem (empty array if none loaded). */
  getFiles: (id: string | null) => OnsiteFile[];
}

export type OnsiteStore = OnsiteStoreState & OnsiteStoreActions & OnsiteStoreSelectors;

const INITIAL_STATE: OnsiteStoreState = {
  problems: [],
  config: null,
  currentProblemId: null,
  uploading: {},
  files: {},
  pendingInitialPrompt: {},
  lastError: null,
  lastFetchedAt: 0,
};

// ─── Hook ──────────────────────────────────────────────────────────────────

// ─── Singleton state + cross-component notify ──────────────────────────────
// 关键设计: state 与 notify 列表都在 module 顶层(整个 app 一份),所有
// useOnsiteStore() 消费者共享同一份 state。早期版本用 hook-local useRef/
// useState,导致 IssueListSidebar / NewIssueWizard / OnsiteChatStream
// 各自一份独立 state——wizard 创建问题后,sidebar 看不到新问题,刷新页面
// 才出现。这里改成 module-level singleton + 订阅 set,所有消费者在
// notify() 时统一重渲染。
//
// 向下兼容老 API: 函数体里仍叫 stateRef.current.X,通过把 stateRef 包成
// `{ current: sharedState }` 保持所有原 `stateRef.current = ...` 赋值点不
// 变(diff 范围更小,review 友好)。
const sharedState: OnsiteStoreState = { ...INITIAL_STATE };
const subscribers: Set<() => void> = new Set();

function notifyAll(): void {
  for (const s of subscribers) {
    try {
      s();
    } catch (err: unknown) {
      console.warn('[onsiteStore] subscriber notify failed:', err);
    }
  }
}

export function useOnsiteStore(): OnsiteStore {
  // 用假 ref 包装,保留原 stateRef.current.X 的全部调用点不变。
  const stateRef = { current: sharedState };
  // `tick` 必须被 useMemo 依赖读取: notify() 递增 tick 触发重渲染后,只有把
  // tick 放进下方 useMemo 的依赖数组,快照才会重新从 stateRef 派生。
  const [tick, setTick] = useState(0);
  // 把 setTick 注册到 module-level 订阅集合;卸载时取消订阅避免泄漏。
  useEffect(() => {
    const sub = () => setTick((n) => n + 1);
    subscribers.add(sub);
    return () => {
      subscribers.delete(sub);
    };
  }, []);
  const notify = useCallback(notifyAll, []);

  /** Read snapshot — callers must have already called `notify()` upstream. */
  const read = useCallback((): OnsiteStoreState => stateRef.current, []);

  // ─── actions ────────────────────────────────────────────────────────────

  const loadConfig = useCallback(async (): Promise<ConfigPayload | null> => {
    try {
      const res = await authenticatedFetch('/api/onsite/config');
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        stateRef.current.lastError = `loadConfig failed: HTTP ${res.status} ${text}`;
        notify();
        return null;
      }
      const payload = (await res.json()) as ConfigPayload;
      stateRef.current.config = payload;
      stateRef.current.lastError = null;
      stateRef.current.lastFetchedAt = Date.now();
      notify();
      return payload;
    } catch (err: unknown) {
      stateRef.current.lastError = err instanceof Error ? err.message : String(err);
      notify();
      return null;
    }
  }, [notify]);

  const loadProblems = useCallback(async (): Promise<ProblemListItem[]> => {
    try {
      const res = await authenticatedFetch('/api/onsite/problems');
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        stateRef.current.lastError = `loadProblems failed: HTTP ${res.status} ${text}`;
        notify();
        return stateRef.current.problems;
      }
      const body = (await res.json()) as { problems?: ProblemListItem[] };
      const list = Array.isArray(body.problems) ? body.problems : [];
      stateRef.current.problems = list;
      stateRef.current.lastError = null;
      stateRef.current.lastFetchedAt = Date.now();
      notify();
      return list;
    } catch (err: unknown) {
      stateRef.current.lastError = err instanceof Error ? err.message : String(err);
      notify();
      return stateRef.current.problems;
    }
  }, [notify]);

  const selectProblem = useCallback((id: string | null): void => {
    if (stateRef.current.currentProblemId === id) return;
    stateRef.current.currentProblemId = id;
    notify();
  }, [notify]);

  const setInitialPrompt = useCallback((id: string, prompt: string): void => {
    if (!id || !prompt.trim()) return;
    stateRef.current.pendingInitialPrompt = {
      ...stateRef.current.pendingInitialPrompt,
      [id]: prompt,
    };
    notify();
  }, [notify]);

  const takeInitialPrompt = useCallback((id: string): string | null => {
    const pending = stateRef.current.pendingInitialPrompt[id];
    if (!pending) return null;
    // 浅拷贝后删 key,再整体替换引用以触发 notify
    const next = { ...stateRef.current.pendingInitialPrompt };
    delete next[id];
    stateRef.current.pendingInitialPrompt = next;
    notify();
    return pending;
  }, [notify]);

  const patchStatus = useCallback(
    async (id: string, to: ProblemStatus, reason: string): Promise<ProblemRecord | null> => {
      try {
        const res = await authenticatedFetch(`/api/onsite/problems/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: to, reason }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          stateRef.current.lastError = `patchStatus failed: HTTP ${res.status} ${text}`;
          notify();
          return null;
        }
        const record = (await res.json()) as ProblemRecord;
        // Server broadcasts state-changed over WS — we still mirror locally
        // so consumers don't have to wait for the round-trip.
        const idx = stateRef.current.problems.findIndex((p) => p.id === id);
        if (idx >= 0) {
          stateRef.current.problems = [
            ...stateRef.current.problems.slice(0, idx),
            { ...stateRef.current.problems[idx], status: record.status },
            ...stateRef.current.problems.slice(idx + 1),
          ];
        }
        stateRef.current.lastError = null;
        notify();
        return record;
      } catch (err: unknown) {
        stateRef.current.lastError = err instanceof Error ? err.message : String(err);
        notify();
        return null;
      }
    },
    [notify],
  );

  const uploadFiles = useCallback(
    async (id: string, files: File[]): Promise<UploadResult[]> => {
      if (files.length === 0) return [];

      const formData = new FormData();
      for (const file of files) {
        formData.append('files', file, file.name);
      }

      // XHR (not fetch) so we can drive `uploading[id]` from onprogress.
      return await new Promise<UploadResult[]>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/onsite/problems/${encodeURIComponent(id)}/files`, true);

        const token = typeof localStorage !== 'undefined' ? localStorage.getItem('auth-token') : null;
        if (token) {
          xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        }

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && event.total > 0) {
            const pct = Math.round((event.loaded / event.total) * 100);
            stateRef.current.uploading = { ...stateRef.current.uploading, [id]: pct };
            notify();
          }
        };

        xhr.onload = () => {
          // 2xx + 207 → resolve; 4xx/5xx → reject with what we know.
          try {
            const body = JSON.parse(xhr.responseText) as { results?: UploadResult[] };
            if (xhr.status >= 200 && xhr.status < 300) {
              // Clear progress on success.
              const next = { ...stateRef.current.uploading };
              delete next[id];
              stateRef.current.uploading = next;
              stateRef.current.lastError = null;
              notify();
              resolve(Array.isArray(body.results) ? body.results : []);
            } else {
              stateRef.current.lastError = `uploadFiles failed: HTTP ${xhr.status}`;
              notify();
              resolve([]);
            }
          } catch (err: unknown) {
            stateRef.current.lastError = err instanceof Error ? err.message : String(err);
            notify();
            resolve([]);
          }
        };

        xhr.onerror = () => {
          stateRef.current.lastError = 'uploadFiles: network error';
          notify();
          resolve([]);
        };

        xhr.send(formData);
      });
    },
    [notify],
  );

  const loadFiles = useCallback(
    async (id: string): Promise<OnsiteFile[]> => {
      try {
        const res = await authenticatedFetch(
          `/api/onsite/problems/${encodeURIComponent(id)}/files`,
        );
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          stateRef.current.lastError = `loadFiles failed: HTTP ${res.status} ${text}`;
          notify();
          return stateRef.current.files[id] ?? [];
        }
        const body = (await res.json()) as { files?: OnsiteFile[] };
        const list = Array.isArray(body.files) ? body.files : [];
        stateRef.current.files = { ...stateRef.current.files, [id]: list };
        stateRef.current.lastError = null;
        notify();
        return list;
      } catch (err: unknown) {
        stateRef.current.lastError = err instanceof Error ? err.message : String(err);
        notify();
        return stateRef.current.files[id] ?? [];
      }
    },
    [notify],
  );

  const loadMessages = useCallback(
    async (id: string): Promise<OnsiteStoredMessage[]> => {
      try {
        const res = await authenticatedFetch(
          `/api/onsite/problems/${encodeURIComponent(id)}/messages`,
        );
        if (!res.ok) {
          // 404 是合法(新 problem 还没消息),不要刷 lastError。
          // 其他非 2xx 才记错误。
          if (res.status !== 404) {
            const text = await res.text().catch(() => '');
            stateRef.current.lastError = `loadMessages failed: HTTP ${res.status} ${text}`;
            notify();
          }
          return [];
        }
        const body = (await res.json()) as { messages?: OnsiteStoredMessage[] };
        return Array.isArray(body.messages) ? body.messages : [];
      } catch (err: unknown) {
        stateRef.current.lastError = err instanceof Error ? err.message : String(err);
        notify();
        return [];
      }
    },
    [notify],
  );

  const deleteProblem = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const res = await authenticatedFetch(
          `/api/onsite/problems/${encodeURIComponent(id)}`,
          { method: 'DELETE' },
        );
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          stateRef.current.lastError = `deleteProblem failed: HTTP ${res.status} ${text}`;
          notify();
          return false;
        }
        // 本地移除(WS 也会推 problems:changed,这里乐观更新让 UI 即时响应)
        stateRef.current.problems = stateRef.current.problems.filter((p) => p.id !== id);
        // 清相关缓存(files / pendingInitialPrompt / uploading)
        if (stateRef.current.files[id]) {
          const nextFiles = { ...stateRef.current.files };
          delete nextFiles[id];
          stateRef.current.files = nextFiles;
        }
        if (stateRef.current.pendingInitialPrompt[id]) {
          const nextPrompts = { ...stateRef.current.pendingInitialPrompt };
          delete nextPrompts[id];
          stateRef.current.pendingInitialPrompt = nextPrompts;
        }
        if (stateRef.current.uploading[id] !== undefined) {
          const nextUploading = { ...stateRef.current.uploading };
          delete nextUploading[id];
          stateRef.current.uploading = nextUploading;
        }
        // 若删的是当前选中,清空选中(调用方据此导航回 /onsite)
        if (stateRef.current.currentProblemId === id) {
          stateRef.current.currentProblemId = null;
        }
        stateRef.current.lastError = null;
        notify();
        return true;
      } catch (err: unknown) {
        stateRef.current.lastError = err instanceof Error ? err.message : String(err);
        notify();
        return false;
      }
    },
    [notify],
  );

  // ─── selectors (snapshot reads) ────────────────────────────────────────

  /** getProblem — returns the matching record or undefined. */
  const getProblem = useCallback(
    (id: string | null): ProblemRecord | undefined => {
      // Subscribes via tick — the consumer is already inside a render.
      if (!id) return undefined;
      return stateRef.current.problems.find((p) => p.id === id);
    },
    [], // selectors intentionally no-op deps; they read the ref each render
  );

  const getUploadProgress = useCallback((id: string): number => {
    return stateRef.current.uploading[id] ?? -1;
  }, []);

  const getAnyUploading = useCallback((): boolean => {
    return Object.keys(stateRef.current.uploading).length > 0;
  }, []);

  const getFiles = useCallback((id: string | null): OnsiteFile[] => {
    if (!id) return [];
    return stateRef.current.files[id] ?? [];
  }, []);

  // ─── exposed surface ──────────────────────────────────────────────────
  // We re-derive the `problems` / `config` / `uploading` snapshots from the
  // ref on every render (which is exactly what `useTick` triggers). This is
  // the same shape zustand's `useStore(selector)` would yield.
  return useMemo<OnsiteStore>(() => {
    const state = read();
    return {
      problems: state.problems,
      config: state.config,
      currentProblemId: state.currentProblemId,
      uploading: state.uploading,
      files: state.files,
      pendingInitialPrompt: state.pendingInitialPrompt,
      lastError: state.lastError,
      lastFetchedAt: state.lastFetchedAt,
      loadConfig,
      loadProblems,
      selectProblem,
      setInitialPrompt,
      takeInitialPrompt,
      patchStatus,
      uploadFiles,
      loadFiles,
      loadMessages,
      deleteProblem,
      getProblem,
      getUploadProgress,
      getAnyUploading,
      getFiles,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: we re-read stateRef on every tick
  }, [
    tick,
    read,
    loadConfig,
    loadProblems,
    selectProblem,
    patchStatus,
    uploadFiles,
    loadFiles,
    loadMessages,
    deleteProblem,
    setInitialPrompt,
    takeInitialPrompt,
    getProblem,
    getUploadProgress,
    getAnyUploading,
    getFiles,
  ]);
}