/**
 * Onsite discipline log — runtime record of discipline middleware events.
 *
 * Three kinds are tracked:
 *   - 'softening'           (use of softening words like 可能 / 大概)
 *   - 'trace-id-empty'      (AI claimed "no trace id" without grep evidence)
 *   - 'trace-id-suspect'    (trace id present but possibly stale)
 *   - 'write-protection'    (raw-log write command detected)
 *
 * Writes are append-only — there is no update or delete API. The log is the
 * evidence trail the StateMachine and the UI use to render discipline
 * badges.
 */

import { getConnection } from '../connection.js';

export type OnsiteDisciplineLogRecord = {
  id: number;
  problem_id: string;
  message_id: string | null;
  kind: string;
  word: string | null;
  position: number | null;
  cmd: string | null;
  stdout_preview: string | null;
  at: string;
};

type DisciplineAppendInput = Omit<OnsiteDisciplineLogRecord, 'id' | 'at'>;

export const onsiteDisciplineLogDb = {
  append(entry: DisciplineAppendInput): number {
    const db = getConnection();
    const info = db
      .prepare(
        `INSERT INTO onsite_discipline_log
           (problem_id, message_id, kind, word, position, cmd, stdout_preview)
         VALUES
           (@problem_id, @message_id, @kind, @word, @position, @cmd, @stdout_preview)`,
      )
      .run({
        problem_id: entry.problem_id,
        message_id: entry.message_id,
        kind: entry.kind,
        word: entry.word,
        position: entry.position,
        cmd: entry.cmd,
        stdout_preview: entry.stdout_preview,
      });
    return Number(info.lastInsertRowid);
  },

  countByProblemId(problemId: string): number {
    const db = getConnection();
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM onsite_discipline_log WHERE problem_id = ?`)
      .get(problemId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  },
};