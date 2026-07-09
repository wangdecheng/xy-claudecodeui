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
  root_cause_text: string | null;
  description: string;
};

export type OnsiteProblemListItem = OnsiteProblemRecord;

type ProblemInsertInput = Omit<OnsiteProblemRecord, 'created_at' | 'updated_at' | 'mtime' | 'root_cause_text'>;

const INSERT_SQL = `
INSERT INTO onsite_problems (
  id, customer, third_bridge_branch, iteration, database, status, cwd, problem_json_path, description
) VALUES (
  @id, @customer, @third_bridge_branch, @iteration, @database, @status, @cwd, @problem_json_path, @description
)
`;

const SELECT_COLUMNS = `
id, customer, third_bridge_branch, iteration, database, status, cwd, problem_json_path,
created_at, updated_at, mtime, root_cause_text, description
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
      description: p.description ?? '',
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
   * 删除一条 problem 记录。子表 onsite_files / onsite_state_audit /
   * onsite_discipline_log 已配置 ON DELETE CASCADE(PRAGMA foreign_keys
   * 已在初始化时启用),会随主表行一并清空,无需手动删。
   * 注意:此方法只清 DB 行,不动磁盘目录与内存缓冲 -- 完整清理请走
   * problemService.remove()(它负责 rm 磁盘 + clear messagesStore)。
   */
  deleteById(id: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM onsite_problems WHERE id = ?').run(id);
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
   * Batch 5 (Sub-task E) cleanup — 写入 root_cause_text 列(不再写
   * problem.json 文件)。Idempotent:重复写入同一 id 覆盖之前的值。
   * 若 id 不存在,no-op(返回 changes=0,不抛)。
   */
  updateRootCause(id: string, rootCauseText: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE onsite_problems
       SET root_cause_text = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(rootCauseText, id);
  },
};