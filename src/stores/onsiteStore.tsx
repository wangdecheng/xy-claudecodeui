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

import { useCallback, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../utils/api';

import type {
  ConfigPayload,
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
  /** PATCH /api/onsite/problems/:id with new status + reason. */
  patchStatus: (id: string, to: ProblemStatus, reason: string) => Promise<ProblemRecord | null>;
  /**
   * POST /api/onsite/problems/:id/files as multipart/form-data. Updates
   * `uploading[problemId]` as it goes (0..100). Throws on hard failure
   * (network / 4xx non-207); 207 multi-status responses resolve to the
   * per-file results array.
   */
  uploadFiles: (id: string, files: File[]) => Promise<UploadResult[]>;
}

export interface OnsiteStoreSelectors {
  /** Pick the problem matching `id` (returns undefined if absent). */
  useProblem: (id: string | null) => ProblemRecord | undefined;
  /** Pick the upload progress (0..100) for one problem; -1 if not uploading. */
  useUploadProgress: (id: string) => number;
  /** True iff any problem currently has uploading[id] defined. */
  useAnyUploading: () => boolean;
}

export type OnsiteStore = OnsiteStoreState & OnsiteStoreActions & OnsiteStoreSelectors;

const INITIAL_STATE: OnsiteStoreState = {
  problems: [],
  config: null,
  currentProblemId: null,
  uploading: {},
  lastError: null,
  lastFetchedAt: 0,
};

// ─── Hook ──────────────────────────────────────────────────────────────────

export function useOnsiteStore(): OnsiteStore {
  const stateRef = useRef<OnsiteStoreState>({ ...INITIAL_STATE });
  const [, setTick] = useState(0);
  const notify = useCallback(() => setTick((n) => n + 1), []);

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

  // ─── selectors (snapshot reads) ────────────────────────────────────────

  /** useProblem — returns the matching record or undefined. */
  const useProblem = useCallback(
    (id: string | null): ProblemRecord | undefined => {
      // Subscribes via tick — the consumer is already inside a render.
      if (!id) return undefined;
      return stateRef.current.problems.find((p) => p.id === id);
    },
    [], // selectors intentionally no-op deps; they read the ref each render
  );

  const useUploadProgress = useCallback((id: string): number => {
    return stateRef.current.uploading[id] ?? -1;
  }, []);

  const useAnyUploading = useCallback((): boolean => {
    return Object.keys(stateRef.current.uploading).length > 0;
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
      lastError: state.lastError,
      lastFetchedAt: state.lastFetchedAt,
      loadConfig,
      loadProblems,
      selectProblem,
      patchStatus,
      uploadFiles,
      useProblem,
      useUploadProgress,
      useAnyUploading,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: we re-read stateRef on every tick
  }, [
    read,
    loadConfig,
    loadProblems,
    selectProblem,
    patchStatus,
    uploadFiles,
    useProblem,
    useUploadProgress,
    useAnyUploading,
  ]);
}