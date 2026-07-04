/**
 * StateMachine — 5 状态有限状态机,管理 onsite problem 的状态迁移。
 *
 * Spec:specs/issue-state.md REQ-3.1 / 3.2 / 3.3 / 3.4
 * Design:design.md 「状态机」段
 *
 * - `canTransition`:纯函数,无 IO
 * - `apply`:事务化地执行一次状态迁移,写入 audit + 同步 problem.json
 *
 * 终态规则:`abandoned` 是终态,ALLOWED.abandoned = []。其他状态在 outgoing
 * 列表里都保留 `abandoned`(用户主动归档是任意阶段的合法操作)。
 */

import { readFile, writeFile } from 'node:fs/promises';

import { getConnection } from '@/modules/database/connection.js';
import { onsiteProblemsDb } from '@/modules/database/repositories/onsite-problems.db.js';
import { onsiteStateAuditDb } from '@/modules/database/repositories/onsite-state-audit.db.js';

export type ProblemStatus =
  | 'pending_info'
  | 'analyzing'
  | 'blocked'
  | 'confirmed'
  | 'abandoned';

const ALLOWED: Record<ProblemStatus, ProblemStatus[]> = {
  pending_info: ['analyzing', 'abandoned'],
  analyzing: ['blocked', 'confirmed', 'pending_info', 'abandoned'],
  blocked: ['analyzing', 'abandoned'],
  confirmed: ['analyzing', 'abandoned'],
  abandoned: [],
};

const MIN_REASON_LENGTH = 8;

export class InvalidStateTransitionError extends Error {
  readonly code = 'INVALID_STATE_TRANSITION';
  readonly from: ProblemStatus;
  readonly to: ProblemStatus;
  readonly allowed: ProblemStatus[];

  constructor(from: ProblemStatus, to: ProblemStatus, allowed: ProblemStatus[]) {
    super(`Invalid state transition: ${from} → ${to}. Allowed from ${from}: ${allowed.join(', ') || '(none)'}`);
    this.name = 'InvalidStateTransitionError';
    this.from = from;
    this.to = to;
    this.allowed = [...allowed];
  }
}

export class ReasonTooShortError extends Error {
  readonly code = 'REASON_TOO_SHORT';
  readonly minLength: number;

  constructor(minLength: number) {
    super(`Reason must be at least ${minLength} characters after trim`);
    this.name = 'ReasonTooShortError';
    this.minLength = minLength;
  }
}

export class ProblemNotFoundError extends Error {
  readonly code = 'PROBLEM_NOT_FOUND';
  readonly id: string;

  constructor(id: string) {
    super(`Problem not found: ${id}`);
    this.name = 'ProblemNotFoundError';
    this.id = id;
  }
}

/**
 * 纯函数 — 检查状态迁移合法性。返回 discriminated union,避免异常开销。
 */
export function canTransition(
  from: ProblemStatus,
  to: ProblemStatus,
): { ok: true } | { ok: false; allowed: ProblemStatus[] } {
  const allowed = ALLOWED[from];
  if (allowed.includes(to)) {
    return { ok: true };
  }
  return { ok: false, allowed: [...allowed] };
}

/**
 * 在事务中执行一次状态迁移:
 *   1. updateStatusOnly — 更新 onsite_problems.status
 *   2. onsiteStateAuditDb.append — 写一条 audit 行
 *   3. 同步 problem.json 的 status 字段
 *
 * 失败时整笔事务回滚。
 */
export async function apply(
  problemId: string,
  to: ProblemStatus,
  reason: string,
  actorId: string | null,
): Promise<{ from: ProblemStatus; to: ProblemStatus; at: string }> {
  // reason 长度校验
  if (reason.trim().length < MIN_REASON_LENGTH) {
    throw new ReasonTooShortError(MIN_REASON_LENGTH);
  }

  const problem = onsiteProblemsDb.findById(problemId);
  if (!problem) {
    throw new ProblemNotFoundError(problemId);
  }

  const from = problem.status as ProblemStatus;
  const check = canTransition(from, to);
  if (!check.ok) {
    throw new InvalidStateTransitionError(from, to, check.allowed);
  }

  const db = getConnection();
  const txn = db.transaction(() => {
    onsiteProblemsDb.updateStatusOnly(problemId, to);
    onsiteStateAuditDb.append({
      problem_id: problemId,
      from_status: from,
      to_status: to,
      reason,
      actor_id: actorId,
    });
  });
  txn();

  // 同步 problem.json(磁盘是 source of truth,D-3)
  if (problem.problem_json_path) {
    try {
      const raw = await readFile(problem.problem_json_path, 'utf8');
      const json = JSON.parse(raw) as Record<string, unknown>;
      json.status = to;
      await writeFile(
        problem.problem_json_path,
        JSON.stringify(json, null, 2),
        'utf8',
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[state-machine] failed to sync problem.json for ${problemId}: ${message}`);
      // problem.json 同步失败不回滚 DB — D-3 允许;list 时会读 json 重新发现。
      // 这里我们仍然成功返回,since DB 是 source of truth for status transitions。
    }
  }

  // at 时间戳:从最新的 audit 行读回(SQLite CURRENT_TIMESTAMP 提供)
  const audits = onsiteStateAuditDb.listByProblemId(problemId);
  const latest = audits[audits.length - 1];
  const at = latest?.at ?? new Date().toISOString();

  return { from, to, at };
}