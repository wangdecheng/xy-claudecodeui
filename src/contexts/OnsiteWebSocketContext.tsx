/**
 * OnsiteWebSocketContext — single-instance WebSocket on `/onsite/ws` for the
 * Customer Onsite Analysis feature.
 *
 * Design (per tasks.md §6.2):
 *  - One singleton WS per browser tab, mounted via `OnsiteWebSocketProvider`.
 *  - Exponential reconnect with jitter, capped at 30s.
 *  - On `open`, send the hello frame `{ kind: 'onsite', problemId, cwd,
 *    userId }`. problemId/cwd are placeholders at boot; Batch 7 will call
 *    `resendHello(...)` whenever the user opens a problem.
 *  - On `message`, dispatch:
 *      - `problems:changed`        → store.loadProblems()
 *      - `problem:<id>:state-changed` → update that problem's status in store.
 *  - Stays independent of `WebSocketContext.tsx` (chat) per contract — chat
 *    WS code is not modified by this batch.
 *
 * Why a separate provider (not piggybacking on chat WS): the onsite path
 * uses a distinct endpoint and distinct handshake; sharing the chat socket
 * would require backporting kind-routing into chat-ws, which the brief
 * explicitly forbids.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useOnsiteStore } from '../stores/onsiteStore';
import type {
  OnsiteHelloFrame,
  OnsiteServerEvent,
} from '@shared/onsite-types';

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

function nextBackoff(prevMs: number): number {
  const jitter = Math.random() * 0.3 * prevMs;
  return Math.min(MAX_BACKOFF_MS, prevMs * 2 + jitter);
}

// ─── Context shape ────────────────────────────────────────────────────────

export type OnsiteWebSocketContextValue = {
  /** True when the WS is currently in OPEN state. */
  isConnected: boolean;
  /** Number of reconnect attempts since boot. Useful for UI diagnostics. */
  reconnectAttempts: number;
  /**
   * Replace the placeholder hello frame and re-send it on the next open.
   * Call this from Batch 7's OnsiteLayout when the user opens a problem.
   */
  setHelloContext: (problemId: string, cwd: string) => void;
  /** Send a raw JSON frame. Returns false if the socket is not open. */
  send: (frame: unknown) => boolean;
};

const OnsiteWebSocketContext = createContext<OnsiteWebSocketContextValue | null>(null);

export function useOnsiteWebSocket(): OnsiteWebSocketContextValue {
  const ctx = useContext(OnsiteWebSocketContext);
  if (!ctx) {
    throw new Error('useOnsiteWebSocket must be used within an OnsiteWebSocketProvider');
  }
  return ctx;
}

// ─── Provider ─────────────────────────────────────────────────────────────

export function OnsiteWebSocketProvider({ children }: { children: React.ReactNode }) {
  // We only need the actions from the store, not the snapshot, so destructure
  // once. (useOnsiteStore's identity is stable across renders.)
  const store = useOnsiteStore();
  const loadProblems = store.loadProblems;

  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef<number>(INITIAL_BACKOFF_MS);

  // Live hello-frame fields — Batch 7 calls setHelloContext to update these.
  const helloRef = useRef<OnsiteHelloFrame>({
    kind: 'onsite',
    problemId: 'placeholder',
    cwd: 'placeholder',
    userId: readUserIdFromLocalStorage(),
  });

  const [isConnected, setIsConnected] = useState(false);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);

  const setHelloContext = useCallback((problemId: string, cwd: string): void => {
    helloRef.current = {
      ...helloRef.current,
      kind: 'onsite',
      problemId,
      cwd,
    };
    // Re-send immediately if the socket is open so the server picks up the
    // new problemId/cwd without waiting for a reconnect.
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(helloRef.current));
      } catch (err: unknown) {
        console.warn('[onsite-ws] failed to resend hello frame:', err);
      }
    }
  }, []);

  const send = useCallback((frame: unknown): boolean => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(frame));
        return true;
      } catch (err: unknown) {
        console.warn('[onsite-ws] send failed:', err);
        return false;
      }
    }
    return false;
  }, []);

  const handleServerEvent = useCallback(
    (event: OnsiteServerEvent): void => {
      if (event.type === 'problems:changed') {
        void loadProblems();
        return;
      }

      // problem:<id>:state-changed
      const match = /^problem:([^:]+):state-changed$/.exec(event.type);
      if (match && match[1]) {
        const id = match[1];
        const payload = event.payload;
        // We re-use store's internal state via selectProblem? No — patchStatus
        // would call PATCH again. We need a local mutation primitive.
        // Instead, reload the whole list — it stays consistent with disk and
        // is cheap relative to a single problem's state machine.
        void loadProblems();
        // Keep payload reachable to consumers via store.lastError = null
        // (success path) — no need to surface the timestamp here.
        void payload;
        void id;
      }
    },
    [loadProblems],
  );

  const connect = useCallback(() => {
    if (unmountedRef.current) return;
    if (wsRef.current) {
      // Already have a socket — don't double-connect.
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token =
      typeof localStorage !== 'undefined' ? localStorage.getItem('auth-token') : null;
    if (!token) {
      // Defer reconnect; user might not be auth'd yet. Backoff still applies.
      scheduleReconnect();
      return;
    }

    const url = `${protocol}//${window.location.host}/onsite/ws?token=${encodeURIComponent(token)}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err: unknown) {
      console.warn('[onsite-ws] failed to construct socket:', err);
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      setIsConnected(true);
      backoffRef.current = INITIAL_BACKOFF_MS; // reset on success
      try {
        socket.send(JSON.stringify(helloRef.current));
      } catch (err: unknown) {
        console.warn('[onsite-ws] failed to send hello frame:', err);
      }
    };

    socket.onmessage = (msgEvent: MessageEvent) => {
      try {
        const data = JSON.parse(String(msgEvent.data)) as unknown;
        if (!data || typeof data !== 'object') return;
        const ev = data as OnsiteServerEvent;
        if (typeof ev.type !== 'string') return;
        handleServerEvent(ev);
      } catch (err: unknown) {
        console.warn('[onsite-ws] failed to parse frame:', err);
      }
    };

    socket.onclose = () => {
      setIsConnected(false);
      wsRef.current = null;
      scheduleReconnect();
    };

    socket.onerror = () => {
      // The close event will fire right after — just log here.
      console.warn('[onsite-ws] socket error');
    };

    wsRef.current = socket;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    function scheduleReconnect(): void {
      if (unmountedRef.current) return;
      const delay = backoffRef.current;
      backoffRef.current = nextBackoff(delay);
      setReconnectAttempts((n) => n + 1);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    }
  }, [handleServerEvent]);

  useEffect(() => {
    unmountedRef.current = false;
    connect();
    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    };
  }, [connect]);

  const value = useMemo<OnsiteWebSocketContextValue>(
    () => ({
      isConnected,
      reconnectAttempts,
      setHelloContext,
      send,
    }),
    [isConnected, reconnectAttempts, setHelloContext, send],
  );

  return (
    <OnsiteWebSocketContext.Provider value={value}>
      {children}
    </OnsiteWebSocketContext.Provider>
  );
}

function readUserIdFromLocalStorage(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem('auth-user');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: unknown };
    if (typeof parsed.id === 'string' || typeof parsed.id === 'number') {
      return String(parsed.id);
    }
    return null;
  } catch {
    return null;
  }
}