/**
 * Onsite problems repository — CRUD for the `onsite_problems` table.
 *
 * Each row maps 1:1 with a `~/work/customer-onsite-analysis/YYYYMMDD-客户/`
 * directory on disk. The `id` is `${YYYYMMDD}-${customer}` (with `_N`
 * suffix on duplicate same-day creation) and is treated as the stable
 * handle between disk and DB.
 */

import { getConnection } from '../connection.js';

type ProblemStatus = 'pending_info' | 'analyzing' | 'blocked' | 'confirmed' | 'abandoned';

export type OnsiteProblemRecord = {
  id: string;
  customer: string;
  third_bridge_branch: string | null;
  iteration: string;
  database: string;
  status: ProblemStatus | string;
  cwd: string;
  problem_json_path: string | null;
  created_at: string;
  updated_at: string;
  mtime: string | null;
};

export type OnsiteProblemListItem = OnsiteProblemRecord;

type ProblemInsertInput = Omit<OnsiteProblemRecord, 'created_at' | 'updated_at' | 'mtime'>;

const INSERT_SQL = `
INSERT INTO onsite_problems (
  id, customer, third_bridge_branch, iteration, database, status, cwd, problem_json_path
) VALUES (
  @id, @customer, @third_bridge_branch, @iteration, @database, @status, @cwd, @problem_json_path
)
`;

const SELECT_COLUMNS = `
id, customer, third_bridge_branch, iteration, database, status, cwd, problem_json_path,
created_at, updated_at, mtime
`;

export const onsiteProblemsDb = {
  insert(p: ProblemInsertInput): string {
    const db = getConnection();
    db.prepare(INSERT_SQL).run({
      id: p.id,
      customer: p.customer,
      third_bridge_branch: p.third_bridge_branch,
      iteration: p.iteration,
      database: p.database,
      status: p.status,
      cwd: p.cwd,
      problem_json_path: p.problem_json_path,
    });
    return p.id;
  },

  findById(id: string): OnsiteProblemRecord | null {
    const db = getConnection();
    const row = db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM onsite_problems WHERE id = ?`)
      .get(id) as OnsiteProblemRecord | undefined;
    return row ?? null;
  },

  findByCwd(cwd: string): OnsiteProblemRecord | null {
    const db = getConnection();
    const row = db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM onsite_problems WHERE cwd = ?`)
      .get(cwd) as OnsiteProblemRecord | undefined;
    return row ?? null;
  },

  list(): OnsiteProblemListItem[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM onsite_problems
         ORDER BY datetime(created_at) DESC, id DESC`,
      )
      .all() as OnsiteProblemListItem[];
  },

  /**
   * Update only the `status` column + bump `updated_at`. The "Only" suffix
   * makes the contract explicit: this method does NOT write an audit row.
   * Callers that need to record the reason / actor must additionally call
   * `onsiteStateAuditDb.append(...)` themselves (ideally inside the same
   * `db.transaction(...)` wrapper to keep the two writes atomic — see
   * Batch 3 StateMachine work).
   *
   * Renamed from `updateStatus(...)` because the previous signature
   * silently swallowed `_reason` / `_actorId`, inviting the next reader
   * to assume those were persisted somewhere.
   */
  updateStatusOnly(id: string, status: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE onsite_problems
       SET status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(status, id);
  },

  updateMtime(id: string, mtime: string): void {
    const db = getConnection();
    db.prepare(`UPDATE onsite_problems SET mtime = ? WHERE id = ?`).run(mtime, id);
  },

  /**
   * Batch 4.3 — 写入根因结论字段(供 confirm-root-cause 端点使用)。
   * 注:实际字段列在 Batch 5/6 才会正式加进 schema,这里先做 best-effort:
   * 如果 root_cause_text 列不存在,降级到 problem_json_path 上的 problem.json。
   */
  updateRootCause(id: string, rootCauseText: string): void {
    const row = this.findById(id);
    if (!row || !row.problem_json_path) return;
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      const raw = fs.readFileSync(row.problem_json_path, 'utf8');
      const json = JSON.parse(raw) as Record<string, unknown>;
      json.root_cause_text = rootCauseText;
      fs.writeFileSync(row.problem_json_path, JSON.stringify(json, null, 2), 'utf8');
    } catch {
      // best-effort,失败不抛
    }
  },
};