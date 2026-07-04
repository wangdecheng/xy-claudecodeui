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
 * payload (snake_case translated to camelCase at the API boundary).
 */
export interface ProblemRecord {
  id: string;
  customer: string;
  thirdBridgeBranch: string | null;
  iteration: string;
  database: string;
  status: ProblemStatus;
  cwd: string;
  /** Absolute path to the on-disk problem.json. null until the file lands. */
  problemJsonPath: string | null;
  /** ISO timestamp the row was created; set server-side. */
  createdAt?: string;
  /** Optional: only populated after confirm-root-cause (Batch 4.3). */
  rootCauseText?: string | null;
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
  problemId: string;
  originalName: string;
  size: number;
  kind: OnsiteFileKind;
  unpackedDir?: string;
  uploadedAt: string;
}

/** Per-file result returned by POST /problems/:id/files (207 multi-status). */
export interface UploadResult {
  ok: boolean;
  originalName: string;
  unpackedDir?: string;
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

export type OnsiteServerEvent =
  | OnsiteProblemsChangedEvent
  | OnsiteProblemStateChangedEvent;

// ─── Store helpers (shared between store + WS context) ────────────────────

/** Identity helper used by the store to no-op when nothing changed. */
export function sameProblemStatus(a: ProblemStatus, b: ProblemStatus): boolean {
  return a === b;
}