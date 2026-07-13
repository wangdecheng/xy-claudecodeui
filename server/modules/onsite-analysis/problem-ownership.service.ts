/**
 * Central object-level authorization for onsite problems.
 *
 * The authenticated transport user is the only accepted identity source.
 * Client bodies, query parameters, and WebSocket hello frames never select
 * the owner used by this service.
 */

import {
  onsiteProblemsDb,
  type OnsiteProblemAccessRecord,
} from '@/modules/database/index.js';

type AuthenticatedUserLike = {
  id?: string | number;
  userId?: string | number;
} | null | undefined;

export type ProblemAuthorizationResult =
  | { ok: true; problem: OnsiteProblemAccessRecord }
  | { ok: false; reason: 'not_found' | 'forbidden' };

export function readAuthenticatedUserId(user: AuthenticatedUserLike): number | null {
  const raw = user?.id ?? user?.userId;
  const numeric = Number(raw);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

export function authorizeOnsiteProblem(
  problemId: string,
  authenticatedUserId: number,
): ProblemAuthorizationResult {
  const problem = onsiteProblemsDb.findAccessRecord(problemId);
  if (!problem) return { ok: false, reason: 'not_found' };
  if (
    problem.owner_user_id === null ||
    problem.owner_user_id !== authenticatedUserId
  ) {
    return { ok: false, reason: 'forbidden' };
  }
  return { ok: true, problem };
}
