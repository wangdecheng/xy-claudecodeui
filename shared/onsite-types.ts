/**
 * Shared types for the Customer Onsite Analysis feature.
 *
 * Mirrors the shape of `/api/onsite/*` REST responses and `/onsite/ws`
 * broadcasts. Lives in `shared/` so the server (Batch 1-5) and the
 * frontend (Batch 6+) can import from a single source.
 *
 * Discriminated unions are used for status transitions so the WS handler
 * in `OnsiteWebSocketContext` can update the store without runtime checks.
 */

// ─── Problem lifecycle ─────────────────────────────────────────────────────

export type ProblemStatus =
  | 'pending_info'
  | 'analyzing'
  | 'blocked'
  | 'confirmed'
  | 'abandoned';

export const PROBLEM_STATUSES: readonly ProblemStatus[] = [
  'pending_info',
  'analyzing',
  'blocked',
  'confirmed',
  'abandoned',
] as const;

// ─── Server records ────────────────────────────────────────────────────────

/**
 * One problem directory under ONSITE_ROOT. Returned by GET /problems and the
 * single-record GET /problems/:id endpoint. Field names mirror the server
 * payload verbatim (snake_case on the wire — see
 * `server/modules/onsite-analysis/problem.service.ts:getById` and
 * `server/modules/onsite-analysis/onsite.routes.ts`).
 */
export interface ProblemRecord {
  id: string;
  customer: string;
  third_bridge_branch: string | null;
  iteration: string;
  database: string;
  status: ProblemStatus;
  cwd: string;
  /** Absolute path to the on-disk problem.json. null until the file lands. */
  problem_json_path: string | null;
  /** ISO timestamp the row was created; set server-side. */
  created_at?: string;
  /** Optional: only populated after confirm-root-cause (Batch 4.3). */
  root_cause_text?: string | null;
  /** Optional: human-readable problem title (e.g. "第三方登录失败"). ≤ 80 chars. Added in Batch 9 (REQ-1.12). */
  title?: string | null;
}

/**
 * The list endpoint (GET /problems) returns ProblemListItem which extends
 * ProblemRecord with `lastActivityAt` for sidebar sort stability.
 */
export type ProblemListItem = ProblemRecord;

// ─── Config (Batch 1) ──────────────────────────────────────────────────────

export interface ConfigCustomer {
  label: string;
  branch: string | null;
}

export interface ConfigPayload {
  status: 'OK' | 'INVALID';
  mtime: string;
  data: {
    customers: ConfigCustomer[];
    iterations: string[];
  };
  error?: string;
}

// ─── Files (Batch 5.4) ────────────────────────────────────────────────────

export type OnsiteFileKind = 'archive' | 'log' | 'image' | 'other';

export interface OnsiteFile {
  id: string;
  problem_id: string;
  original_name: string;
  size: number;
  kind: OnsiteFileKind;
  /** Absolute path where the uploaded archive is stored (server row field). */
  stored_path?: string;
  unpacked_dir?: string;
  uploaded_at: string;
}

/** Per-file result returned by POST /problems/:id/files (207 multi-status). */
export interface UploadResult {
  ok: boolean;
  original_name: string;
  unpacked_dir?: string;
  size?: number;
  error?: string;
}

// ─── WebSocket protocol ────────────────────────────────────────────────────

/**
 * First frame the client MUST send over `/onsite/ws`. The server validates
 * `kind === 'onsite'` and asserts `cwd` lives under ONSITE_ROOT.
 *
 * `problemId` / `cwd` can be placeholders during the bootstrap handshake —
 * the Batch 7 layout will re-send a fresh hello frame when the user opens
 * a specific problem.
 */
export interface OnsiteHelloFrame {
  kind: 'onsite';
  problemId: string;
  cwd: string;
  userId: string | null;
}

/** Server push: list changed (file added, problem created, etc). */
export interface OnsiteProblemsChangedEvent {
  type: 'problems:changed';
}

/** Server push: one problem's status transitioned. */
export interface OnsiteProblemStateChangedEvent {
  type: `problem:${string}:state-changed`;
  payload: {
    id: string;
    from: ProblemStatus;
    to: ProblemStatus;
    reason: string;
    at: string;
  };
}

// ─── Discipline envelope (Batch 8 I3) ─────────────────────────────────────
//
// 三个 discipline 中间件会向 outbound envelope 注入 `discipline: { ... }` 子结构。
// 由于改动 server middleware 受 Batch 8 约束(只允许 Phase 0 I1 动 server),
// 这里按 server 实际发送的 camelCase 字段命名(snake_case 是 proposal 计划,
// 但 middleware 未切换)。该 envelope 是**叠加型** — softening/traceId/write-protection
// 三个标志可同时存在。
//
// 字段来源:
//   discipline-softening.middleware.ts → { softening: true, words: [{word,position}] }
//   discipline-trace-id.middleware.ts → { traceIdEmpty?: true, matchedText?, cmd?, traceId?,
//                                          traceIdSuspect?: true }
//   discipline-write-protection.middleware.ts → { writeOriginalLog: true, cmd }

export interface SofteningWordMatch {
  word: string;
  position: number;
}

export interface OnsiteDisciplineEnvelope {
  softening?: boolean;
  words?: SofteningWordMatch[];
  traceIdEmpty?: boolean;
  traceIdSuspect?: boolean;
  writeOriginalLog?: boolean;
  matchedText?: string;
  cmd?: string;
  traceId?: string;
}

/**
 * Generic WS frame envelope carrying any of {kind, role, content, discipline}.
 * `discipline` 由 OnsiteChatStream 用作纪律计数/渲染触发器。
 */
export interface OnsiteChatFrame {
  kind?: string;
  role?: 'user' | 'assistant' | string;
  sessionId?: string;
  id?: string | number;
  content?: string;
  text?: string;
  name?: string;
  discipline?: OnsiteDisciplineEnvelope;
}

export type OnsiteServerEvent =
  | OnsiteProblemsChangedEvent
  | OnsiteProblemStateChangedEvent
  | OnsiteChatFrame;

// ─── Store helpers (shared between store + WS context) ────────────────────

/** Identity helper used by the store to no-op when nothing changed. */
export function sameProblemStatus(a: ProblemStatus, b: ProblemStatus): boolean {
  return a === b;
}