/**
 * Onsite files repository — file metadata stored alongside each problem.
 *
 * Files may be logs (the most common case, uploaded as zips and unpacked)
 * or any other artifact the user attached to the problem directory.
 */

import { getConnection } from '../connection.js';

export type OnsiteFileRecord = {
  id: string;
  problem_id: string;
  original_name: string;
  stored_path: string;
  size: number;
  kind: string;
  unpacked_dir: string | null;
  uploaded_at: string;
};

type FileInsertInput = Omit<OnsiteFileRecord, 'uploaded_at'>;

const INSERT_SQL = `
INSERT INTO onsite_files (
  id, problem_id, original_name, stored_path, size, kind, unpacked_dir
) VALUES (
  @id, @problem_id, @original_name, @stored_path, @size, @kind, @unpacked_dir
)
`;

const SELECT_COLUMNS = `
id, problem_id, original_name, stored_path, size, kind, unpacked_dir, uploaded_at
`;

export const onsiteFilesDb = {
  insert(f: FileInsertInput): string {
    const db = getConnection();
    db.prepare(INSERT_SQL).run({
      id: f.id,
      problem_id: f.problem_id,
      original_name: f.original_name,
      stored_path: f.stored_path,
      size: f.size,
      kind: f.kind,
      unpacked_dir: f.unpacked_dir,
    });
    return f.id;
  },

  findById(id: string): OnsiteFileRecord | null {
    const db = getConnection();
    const row = db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM onsite_files WHERE id = ?`)
      .get(id) as OnsiteFileRecord | undefined;
    return row ?? null;
  },

  findByProblemId(problemId: string): OnsiteFileRecord[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM onsite_files
         WHERE problem_id = ?
         ORDER BY datetime(uploaded_at) DESC, id ASC`,
      )
      .all(problemId) as OnsiteFileRecord[];
  },

  list(): OnsiteFileRecord[] {
    const db = getConnection();
    return db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM onsite_files ORDER BY datetime(uploaded_at) DESC`)
      .all() as OnsiteFileRecord[];
  },
};