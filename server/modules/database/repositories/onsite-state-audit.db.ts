/**
 * Onsite state audit log — append-only history of state transitions.
 *
 * Every status change writes one row. The `at` timestamp uses SQLite
 * CURRENT_TIMESTAMP so all rows are normalized to UTC.
 */

import { getConnection } from '../connection.js';

export type OnsiteStateAuditRecord = {
  id: number;
  problem_id: string;
  from_status: string | null;
  to_status: string;
  reason: string;
  actor_id: string | null;
  at: string;
};

type AuditAppendInput = Omit<OnsiteStateAuditRecord, 'id' | 'at'>;

const SELECT_COLUMNS = `
id, problem_id, from_status, to_status, reason, actor_id, at
`;

export const onsiteStateAuditDb = {
  append(audit: AuditAppendInput): number {
    const db = getConnection();
    const info = db
      .prepare(
        `INSERT INTO onsite_state_audit (problem_id, from_status, to_status, reason, actor_id)
         VALUES (@problem_id, @from_status, @to_status, @reason, @actor_id)`,
      )
      .run({
        problem_id: audit.problem_id,
        from_status: audit.from_status,
        to_status: audit.to_status,
        reason: audit.reason,
        actor_id: audit.actor_id,
      });
    return Number(info.lastInsertRowid);
  },

  listByProblemId(problemId: string): OnsiteStateAuditRecord[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM onsite_state_audit
         WHERE problem_id = ?
         ORDER BY id ASC`,
      )
      .all(problemId) as OnsiteStateAuditRecord[];
  },
};