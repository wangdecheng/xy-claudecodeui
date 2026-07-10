import { createHash } from 'node:crypto';

import { Database } from 'better-sqlite3';

import {
  APP_CONFIG_TABLE_SCHEMA_SQL,
  LAST_SCANNED_AT_SQL,
  MIGRATIONS_APPLIED_TABLE_SCHEMA_SQL,
  NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL,
  ONSITE_DISCIPLINE_LOG_TABLE_SCHEMA_SQL,
  ONSITE_FILES_TABLE_SCHEMA_SQL,
  ONSITE_PROBLEMS_TABLE_SCHEMA_SQL,
  ONSITE_STATE_AUDIT_TABLE_SCHEMA_SQL,
  PROJECTS_TABLE_SCHEMA_SQL,
  PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL,
  SESSIONS_TABLE_SCHEMA_SQL,
  USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL,
  VAPID_KEYS_TABLE_SCHEMA_SQL,
} from '@/modules/database/schema.js';

const SQLITE_UUID_SQL = `
lower(hex(randomblob(4))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(6)))
`;

type TableInfoRow = {
  name: string;
  pk: number;
};

const addColumnToTableIfNotExists = (
  db: Database,
  tableName: string,
  columnNames: string[],
  columnName: string,
  columnType: string
) => {
  if (!columnNames.includes(columnName)) {
    console.log(`Running migration: Adding ${columnName} column to ${tableName} table`);
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
};

const tableExists = (db: Database, tableName: string): boolean =>
  Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName)
  );

const getTableInfo = (db: Database, tableName: string): TableInfoRow[] =>
  db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];

const migrateLegacySessionNames = (db: Database): void => {
  const hasLegacySessionNamesTable = tableExists(db, 'session_names');
  const hasSessionsTable = tableExists(db, 'sessions');

  if (!hasLegacySessionNamesTable) {
    return;
  }

  if (hasSessionsTable) {
    console.log('Running migration: Merging session_names into sessions');
    db.exec(`
      INSERT INTO sessions (session_id, provider, custom_name, created_at, updated_at)
      SELECT
        session_id,
        COALESCE(provider, 'claude'),
        custom_name,
        COALESCE(created_at, CURRENT_TIMESTAMP),
        COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM session_names
      WHERE true
      ON CONFLICT(session_id) DO UPDATE SET
        provider = excluded.provider,
        custom_name = COALESCE(excluded.custom_name, sessions.custom_name),
        created_at = COALESCE(sessions.created_at, excluded.created_at),
        updated_at = COALESCE(excluded.updated_at, sessions.updated_at)
    `);
    db.exec('DROP TABLE session_names');
    return;
  }

  console.log('Running migration: Renaming session_names table to sessions');
  db.exec('ALTER TABLE session_names RENAME TO sessions');
};

const migrateLegacyWorkspaceTableIntoProjects = (db: Database): void => {
  db.exec(PROJECTS_TABLE_SCHEMA_SQL);

  if (!tableExists(db, 'workspace_original_paths')) {
    return;
  }

  console.log('Running migration: Migrating workspace_original_paths data into projects');
  db.exec(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      CASE
        WHEN workspace_id IS NULL OR trim(workspace_id) = ''
        THEN ${SQLITE_UUID_SQL}
        ELSE workspace_id
      END,
      workspace_path,
      custom_workspace_name,
      COALESCE(isStarred, 0),
      0
    FROM workspace_original_paths
    WHERE workspace_path IS NOT NULL AND trim(workspace_path) <> ''
    ON CONFLICT(project_path) DO UPDATE SET
      custom_project_name = COALESCE(projects.custom_project_name, excluded.custom_project_name),
      isStarred = COALESCE(projects.isStarred, excluded.isStarred)
  `);
};

const rebuildProjectsTableWithPrimaryKeySchema = (db: Database): void => {
  const hasProjectsTable = tableExists(db, 'projects');
  if (!hasProjectsTable) {
    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    return;
  }

  const projectsTableInfo = getTableInfo(db, 'projects');
  const columnNames = projectsTableInfo.map((column) => column.name);
  const hasProjectIdPrimaryKey = projectsTableInfo.some(
    (column) => column.name === 'project_id' && column.pk === 1,
  );

  if (hasProjectIdPrimaryKey) {
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'custom_project_name', 'TEXT DEFAULT NULL');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isStarred', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0');
    db.exec(`
      UPDATE projects
      SET project_id = ${SQLITE_UUID_SQL}
      WHERE project_id IS NULL OR trim(project_id) = ''
    `);
    return;
  }

  console.log('Running migration: Rebuilding projects table to enforce project_id primary key');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const customProjectNameExpression = columnNames.includes('custom_project_name')
    ? 'custom_project_name'
    : columnNames.includes('custom_workspace_name')
      ? 'custom_workspace_name'
      : 'NULL';

  const isStarredExpression = columnNames.includes('isStarred') ? 'COALESCE(isStarred, 0)' : '0';

  const isArchivedExpression = columnNames.includes('isArchived') ? 'COALESCE(isArchived, 0)' : '0';

  const projectIdExpression = columnNames.includes('project_id')
    ? `CASE
         WHEN project_id IS NULL OR trim(project_id) = ''
         THEN ${SQLITE_UUID_SQL}
         ELSE project_id
       END`
    : SQLITE_UUID_SQL;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS projects__new');
    db.exec(`
      CREATE TABLE projects__new (
        project_id TEXT PRIMARY KEY NOT NULL,
        project_path TEXT NOT NULL UNIQUE,
        custom_project_name TEXT DEFAULT NULL,
        isStarred BOOLEAN DEFAULT 0,
        isArchived BOOLEAN DEFAULT 0
      )
    `);
    db.exec(`
      WITH source_rows AS (
        SELECT
          ${projectPathExpression} AS project_path,
          ${customProjectNameExpression} AS custom_project_name,
          ${isStarredExpression} AS isStarred,
          ${isArchivedExpression} AS isArchived,
          ${projectIdExpression} AS candidate_project_id,
          rowid AS source_rowid
        FROM projects
        WHERE ${projectPathExpression} IS NOT NULL AND trim(${projectPathExpression}) <> ''
      ),
      deduped_paths AS (
        SELECT
          project_path,
          custom_project_name,
          isStarred,
          isArchived,
          candidate_project_id,
          source_rowid,
          ROW_NUMBER() OVER (PARTITION BY project_path ORDER BY source_rowid) AS project_path_rank
        FROM source_rows
      ),
      prepared_rows AS (
        SELECT
          CASE
            WHEN ROW_NUMBER() OVER (PARTITION BY candidate_project_id ORDER BY source_rowid) = 1
            THEN candidate_project_id
            ELSE ${SQLITE_UUID_SQL}
          END AS project_id,
          project_path,
          custom_project_name,
          isStarred,
          isArchived
        FROM deduped_paths
        WHERE project_path_rank = 1
      )
      INSERT INTO projects__new (
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived
      )
      SELECT
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived
      FROM prepared_rows
    `);
    db.exec('DROP TABLE projects');
    db.exec('ALTER TABLE projects__new RENAME TO projects');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
};

const rebuildSessionsTableWithProjectSchema = (db: Database): void => {
  const hasSessions = tableExists(db, 'sessions');
  if (!hasSessions) {
    db.exec(SESSIONS_TABLE_SCHEMA_SQL);
    return;
  }

  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);
  const primaryKeyColumns = sessionsTableInfo
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);

  const shouldRebuild =
    !columnNames.includes('project_path') ||
    primaryKeyColumns.length !== 1 ||
    primaryKeyColumns[0] !== 'session_id' ||
    !columnNames.includes('provider');

  if (!shouldRebuild) {
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'jsonl_path', 'TEXT');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'created_at', 'DATETIME');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'updated_at', 'DATETIME');
    db.exec('UPDATE sessions SET isArchived = COALESCE(isArchived, 0)');
    db.exec('UPDATE sessions SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP)');
    db.exec('UPDATE sessions SET updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)');
    return;
  }

  console.log('Running migration: Rebuilding sessions table to project-based schema');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const providerExpression = columnNames.includes('provider')
    ? "COALESCE(provider, 'claude')"
    : "'claude'";

  const customNameExpression = columnNames.includes('custom_name')
    ? 'custom_name'
    : 'NULL';

  const jsonlPathExpression = columnNames.includes('jsonl_path')
    ? 'jsonl_path'
    : 'NULL';

  const isArchivedExpression = columnNames.includes('isArchived')
    ? 'COALESCE(isArchived, 0)'
    : '0';

  const createdAtExpression = columnNames.includes('created_at')
    ? 'COALESCE(created_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  const updatedAtExpression = columnNames.includes('updated_at')
    ? 'COALESCE(updated_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS sessions__new');
    db.exec(`
      CREATE TABLE sessions__new (
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        custom_name TEXT,
        project_path TEXT,
        jsonl_path TEXT,
        isArchived BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id),
        FOREIGN KEY (project_path) REFERENCES projects(project_path)
        ON DELETE SET NULL
        ON UPDATE CASCADE
      )
    `);
    db.exec(`
      WITH source_rows AS (
        SELECT
          session_id,
          ${providerExpression} AS provider,
          ${customNameExpression} AS custom_name,
          ${projectPathExpression} AS project_path,
          ${jsonlPathExpression} AS jsonl_path,
          ${isArchivedExpression} AS isArchived,
          ${createdAtExpression} AS created_at,
          ${updatedAtExpression} AS updated_at,
          rowid AS source_rowid
        FROM sessions
        WHERE session_id IS NOT NULL AND trim(session_id) <> ''
      ),
      ranked_rows AS (
        SELECT
          session_id,
          provider,
          custom_name,
          project_path,
          jsonl_path,
          isArchived,
          created_at,
          updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY session_id
            ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, source_rowid DESC
          ) AS session_rank
        FROM source_rows
      )
      INSERT INTO sessions__new (
        session_id,
        provider,
        custom_name,
        project_path,
        jsonl_path,
        isArchived,
        created_at,
        updated_at
      )
      SELECT
        session_id,
        provider,
        custom_name,
        project_path,
        jsonl_path,
        isArchived,
        created_at,
        updated_at
      FROM ranked_rows
      WHERE session_rank = 1
    `);
    db.exec('DROP TABLE sessions');
    db.exec('ALTER TABLE sessions__new RENAME TO sessions');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
};

/**
 * Adds the `provider_session_id` mapping column used by the session gateway.
 *
 * Rows that existed before this migration were always keyed directly by the
 * provider-native session id, so backfilling `provider_session_id` with
 * `session_id` keeps every legacy row resolvable through the new mapping.
 */
const addProviderSessionIdMapping = (db: Database): void => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'provider_session_id', 'TEXT');
  // 仅回填 chat 行:它们的 session_id 历史上就是 provider-native id(早期
  // 版本直接把 Claude 的 UUID 当主键),所以 session_id → provider_session_id
  // 是 1:1 不变映射。
  //
  // 必须显式排除 onsite 行:onsite session 由 problemId 当主键(如
  // `20260706-其他问题`),Claude CLI 拒绝非 UUID 的 --resume 值
  // (`Provided value "20260706-..." is not a UUID and does not match any
  // session title`)。onsite 的 provider_session_id 必须由 Claude runtime
  // 真正跑出第一个 session 时写回(UUID),空着等它回写才对。
  db.exec(`
    UPDATE sessions
    SET provider_session_id = session_id
    WHERE provider_session_id IS NULL
      AND (kind IS NULL OR kind = 'chat')
  `);
};

const ensureProjectsForSessionPaths = (db: Database): void => {
  if (!tableExists(db, 'sessions')) {
    return;
  }

  db.exec(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      ${SQLITE_UUID_SQL},
      project_path,
      NULL,
      0,
      0
    FROM sessions
    WHERE project_path IS NOT NULL AND trim(project_path) <> ''
    ON CONFLICT(project_path) DO NOTHING
  `);
};

export const runMigrations = (db: Database) => {
  // Wrap the entire migration flow in a single transaction so partial
  // failures roll back every step. This is the C-4 fix: previously a failure
  // on step N left steps 1..N-1 committed, producing a half-baked schema that
  // downstream code couldn't trust.
  //
  // better-sqlite3's `db.transaction(fn)` returns a wrapped function. SQLite
  // SAVEPOINT semantics mean any `exec` inside the wrapper that throws rolls
  // back the whole transaction, including the migrations_applied rows we
  // write per-step.
  const migrateAll = db.transaction(() => {
    const usersTableInfo = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    const userColumnNames = usersTableInfo.map((column) => column.name);

    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_name', 'TEXT');
    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_email', 'TEXT');
    addColumnToTableIfNotExists(
      db,
      'users',
      userColumnNames,
      'has_completed_onboarding',
      'BOOLEAN DEFAULT 0'
    );

    db.exec(APP_CONFIG_TABLE_SCHEMA_SQL);
    db.exec(USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL);
    db.exec(VAPID_KEYS_TABLE_SCHEMA_SQL);
    db.exec(PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL);
    db.exec('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id)');
    db.exec(NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL);
    db.exec('CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_user_channel ON notification_channel_endpoints(user_id, channel)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_enabled ON notification_channel_endpoints(enabled)');

    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    rebuildProjectsTableWithPrimaryKeySchema(db);

    migrateLegacyWorkspaceTableIntoProjects(db);
    rebuildSessionsTableWithProjectSchema(db);
    migrateLegacySessionNames(db);
    addProviderSessionIdMapping(db);
    ensureProjectsForSessionPaths(db);

    db.exec('CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_provider_session_id ON sessions(provider_session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_is_archived ON sessions(isArchived)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_starred ON projects(isStarred)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_archived ON projects(isArchived)');

    db.exec('DROP INDEX IF EXISTS idx_session_names_lookup');
    db.exec('DROP INDEX IF EXISTS idx_sessions_workspace_path');
    db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_is_starred');
    db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_workspace_id');

    if (tableExists(db, 'workspace_original_paths')) {
      console.log('Running migration: Dropping legacy workspace_original_paths table');
      db.exec('DROP TABLE workspace_original_paths');
    }

    db.exec(LAST_SCANNED_AT_SQL);

    // ---- Onsite analysis schema (Batch 2 of customer-onsite-analysis-ui) ----
    // Sessions table: add kind + cwd + third_bridge_branch + iteration + database
    addSessionsKindAndOnsiteColumns(db);
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_kind_cwd ON sessions(kind, cwd)');

    // New onsite tables — created in dependency order so foreign keys resolve.
    // All four use IF NOT EXISTS so a partially-applied legacy state can heal
    // itself if verifyMigrations is bypassed.
    db.exec(ONSITE_PROBLEMS_TABLE_SCHEMA_SQL);
    db.exec(ONSITE_FILES_TABLE_SCHEMA_SQL);
    db.exec(ONSITE_STATE_AUDIT_TABLE_SCHEMA_SQL);
    db.exec(ONSITE_DISCIPLINE_LOG_TABLE_SCHEMA_SQL);

    // 多用户隔离：给 sessions 表添加 user_id 列
    addSessionsUserIdColumn(db);

    // Batch 5 (Sub-task E) cleanup — add root_cause_text to existing
    // onsite_problems tables (those created before this column existed).
    // Idempotent: PRAGMA table_info skip when already present.
    const onsiteProblemsColumns = getTableInfo(db, 'onsite_problems').map((c) => c.name);
    addColumnToTableIfNotExists(db, 'onsite_problems', onsiteProblemsColumns, 'root_cause_text', 'TEXT');
    addColumnToTableIfNotExists(db, 'onsite_problems', onsiteProblemsColumns, 'description', 'TEXT DEFAULT \'\'');

    // 放宽 onsite_problems.database 的 NOT NULL 约束: 旧 schema 把 database
    // 设为 NOT NULL, 但 ProblemService.create 在 database='other' 时存 null,
    // 触发 NOT NULL constraint failed。必须先 addColumnToTableIfNotExists
    // 把列补齐, 再做"重建表去掉 NOT NULL"的事, 否则新列不会带过去。
    dropOnsiteProblemsDatabaseNotNull(db);

    // Onsite indexes (kept in migrations so we don't depend on INIT_SCHEMA_SQL
    // having run for an upgraded database that pre-dates these tables).
    db.exec('CREATE INDEX IF NOT EXISTS idx_onsite_problems_cwd ON onsite_problems(cwd)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_onsite_problems_status ON onsite_problems(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_onsite_files_problem_id ON onsite_files(problem_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_onsite_state_audit_problem_id ON onsite_state_audit(problem_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_onsite_discipline_log_problem_id ON onsite_discipline_log(problem_id)');
  });

  // migrations_applied is created BEFORE the transaction so the very first
  // step can write to it without self-deadlocking. Pre-existing tables are
  // detected via IF NOT EXISTS.
  db.exec(MIGRATIONS_APPLIED_TABLE_SCHEMA_SQL);

  try {
    migrateAll();
    recordAppliedMigrations(db);
    console.log('Database migrations completed successfully');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error running migrations:', message);
    throw error;
  }
};

/**
 * Adds the onsite columns to an existing `sessions` table.
 *
 * Idempotent: each column is checked via PRAGMA table_info and skipped if
 * already present. SQLite does not support adding CHECK constraints via
 * ALTER TABLE, so the `kind` column is added as a plain TEXT and the CHECK
 * constraint is enforced at the application layer (sessionsDb validates
 * kind before write). On fresh installs the CHECK is part of
 * SESSIONS_TABLE_SCHEMA_SQL.
 *
 * **Not tracked by ONSITE_MIGRATION_STEPS / SHA integrity check.** The ALTER
 * statements below are intentionally NOT exposed as a migration step because
 * SQLite's ALTER TABLE cannot be hashed consistently from a fixed string
 * (the statement either no-ops via the column-already-exists PRAGMA check, or
 * it adds the column — there is no stable "DDL body" to hash). Tracking
 * drift here would mean a false-ok on every edit. The application-layer
 * `assertSessionKind` guard (sessionsDb) is the real safety net for upgrades.
 */
/**
 * 多用户隔离：给已有 sessions 表添加 user_id 列。
 * 幂等：通过 PRAGMA table_info 检测，已存在则跳过。
 * 旧数据的 user_id 保持 NULL（公开可见，向后兼容）。
 */
const addSessionsUserIdColumn = (db: Database): void => {
  const info = getTableInfo(db, 'sessions');
  if (!info.length) {
    return;
  }
  const columnNames = info.map((c) => c.name);
  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'user_id', 'INTEGER');
};

/**
 * 放宽 onsite_problems.database 列的 NOT NULL 约束, 允许 service 层把
 * `database === 'other'` (代表"用户暂未指定") 落 null。SQLite 没有
 * `ALTER TABLE ... DROP NOT NULL`, 标准做法是重建表 —— 走 5 步:
 *
 *   1. CREATE TABLE _new (..., database TEXT, ...)  // 不带 NOT NULL
 *   2. INSERT INTO _new SELECT ... FROM 旧表        // 拷数据
 *   3. DROP TABLE 旧表
 *   4. ALTER TABLE _new RENAME TO 原表名
 *   5. 重建索引 (PRAGMA table_info 拿不到索引列表, 用 IF NOT EXISTS
 *      兜底; sqlite_master 查索引更稳, 这里直接 hardcode onsite 用到的
 *      两条, 跟 migrateAll 里其他 CREATE INDEX 保持一致)
 *
 * 幂等: PRAGMA table_info 读 notnull 列, 已经为 0 直接 return;
 * 迁移已经在 transaction 内, 任何步骤失败整批回滚。
 *
 * 触发条件: 老 DB 在 schema.ts 改之前的 NOT NULL 版本上建的。
 */
type TableInfoFullRow = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: unknown;
};

const getFullTableInfo = (db: Database, tableName: string): TableInfoFullRow[] =>
  db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoFullRow[];

const dropOnsiteProblemsDatabaseNotNull = (db: Database): void => {
  if (!tableExists(db, 'onsite_problems')) {
    // 新 DB: ONSITE_PROBLEMS_TABLE_SCHEMA_SQL 已经是 nullable, 无事可做
    return;
  }
  const cols = getFullTableInfo(db, 'onsite_problems');
  const dbCol = cols.find((c) => c.name === 'database');
  if (!dbCol) {
    // 旧 schema 演化路径上偶发情况: 列都没了, 跳过
    return;
  }
  if (dbCol.notnull === 0) {
    // 已经 nullable, 幂等通过
    return;
  }
  console.log(
    'Running migration: Dropping NOT NULL on onsite_problems.database ' +
      '(recreate-table, see migrations.ts:dropOnsiteProblemsDatabaseNotNull)',
  );

  // 动态拼列定义, 保持原列名/类型/默认值/主键, 只对 database 去掉 NOT NULL
  const columnDefs = cols
    .map((c) => {
      // 本次迁移只对 database 这一列去掉 NOT NULL, 其他列严格按原表复刻
      const notNull = c.name === 'database' ? '' : c.notnull ? ' NOT NULL' : '';
      const defaultClause = c.dflt_value === null ? '' : ` DEFAULT ${JSON.stringify(c.dflt_value)}`;
      const pk = c.pk ? ' PRIMARY KEY' : '';
      return `${c.name} ${c.type || 'TEXT'}${notNull}${defaultClause}${pk}`;
    })
    .join(',\n    ');

  db.exec(`
    CREATE TABLE onsite_problems_new (
      ${columnDefs}
    );
    INSERT INTO onsite_problems_new
      SELECT ${cols.map((c) => c.name).join(', ')} FROM onsite_problems;
    DROP TABLE onsite_problems;
    ALTER TABLE onsite_problems_new RENAME TO onsite_problems;
  `);

  // 重建 onsite_problems 的索引 (DROP TABLE 把索引一起带走, RENAME 不会恢复)
  db.exec('CREATE INDEX IF NOT EXISTS idx_onsite_problems_cwd ON onsite_problems(cwd)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_onsite_problems_status ON onsite_problems(status)');
};

const addSessionsKindAndOnsiteColumns = (db: Database): void => {
  const info = getTableInfo(db, 'sessions');
  if (!info.length) {
    // Sessions table doesn't exist yet — INIT_SCHEMA_SQL will create it with
    // the right shape, nothing to do here.
    return;
  }

  const columnNames = info.map((c) => c.name);

  if (!columnNames.includes('kind')) {
    console.log('Running migration: Adding kind column to sessions table');
    db.exec(`ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'`);
  }

  for (const [name, type] of [
    ['cwd', 'TEXT'],
    ['third_bridge_branch', 'TEXT'],
    ['iteration', 'TEXT'],
    ['database', 'TEXT'],
  ] as const) {
    if (!columnNames.includes(name)) {
      console.log(`Running migration: Adding ${name} column to sessions table`);
      db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
    }
  }
};

// ---------------------------------------------------------------------------
// Migration integrity (Batch 2 / C-4 patch)
// ---------------------------------------------------------------------------

export class MigrationCorruptionError extends Error {
  readonly code = 'MIGRATION_CORRUPTION';
  readonly missing: string[];
  readonly corrupt: Array<{ name: string; expectedSha: string; actualSha: string }>;

  constructor(
    message: string,
    missing: string[],
    corrupt: Array<{ name: string; expectedSha: string; actualSha: string }>,
  ) {
    super(message);
    this.name = 'MigrationCorruptionError';
    this.missing = missing;
    this.corrupt = corrupt;
  }
}

export type VerifyMigrationsResult =
  | { ok: true; version: number }
  | {
      ok: false;
      missing: string[];
      corrupt: Array<{ name: string; expectedSha: string; actualSha: string }>;
    };

/**
 * Verify that every migration step the current code expects has been applied,
 * and that none of the recorded SHAs have drifted from what we expect.
 *
 * "Missing" means the code declares a step that was never recorded in the
 * DB — usually means the migrations runner hasn't run, or rolled back.
 *
 * "Corrupt" means the recorded SHA differs from the expected SHA — the step
 * ran, but the underlying SQL changed in a way the integrity check refuses
 * to silently accept. This catches the failure mode where a developer edits
 * a SQL constant without bumping the migration name.
 *
 * **Scope**: only DDL statements that produce a stable, hashable SQL body
 * are tracked here. Idempotent ALTER steps that branch on `PRAGMA table_info`
 * (notably `addSessionsKindAndOnsiteColumns` for the sessions.kind/cwd/...
 * columns) are intentionally NOT in ONSITE_MIGRATION_STEPS — see the JSDoc
 * on `addSessionsKindAndOnsiteColumns` for the rationale.
 *
 * Returns the user_version PRAGMA as `version` on success so callers can
 * log a single number for ops dashboards.
 */
export const verifyMigrations = (db: Database): VerifyMigrationsResult => {
  const tablePresent = tableExists(db, 'migrations_applied');
  const recordedRows = tablePresent
    ? (db
        .prepare('SELECT name, sha FROM migrations_applied ORDER BY id ASC')
        .all() as Array<{ name: string; sha: string }>)
    : [];
  const recorded = new Map(recordedRows.map((r) => [r.name, r.sha]));

  const missing: string[] = [];
  const corrupt: Array<{ name: string; expectedSha: string; actualSha: string }> = [];

  for (const step of ONSITE_MIGRATION_STEPS) {
    const recordedSha = recorded.get(step.name);
    if (!recordedSha) {
      missing.push(step.name);
      continue;
    }
    if (recordedSha !== step.sha) {
      corrupt.push({ name: step.name, expectedSha: step.sha, actualSha: recordedSha });
    }
  }

  const userVersion = (db.pragma('user_version', { simple: true }) as number) ?? 0;

  if (missing.length === 0 && corrupt.length === 0) {
    return { ok: true, version: userVersion };
  }
  return { ok: false, missing, corrupt };
};

/**
 * Records every migration step the current code defines into migrations_applied
 * with its SHA-256. Called at the tail of `runMigrations` so the integrity
 * check has a complete record on the next startup.
 *
 * The SHA is computed over the SQL body (which detects drift if the SQL
 * constant changes). We deliberately don't include the file path so the SHA
 * survives git moves.
 */
export const recordAppliedMigrations = (db: Database): void => {
  const insert = db.prepare(
    `INSERT INTO migrations_applied (name, sha, applied_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(name) DO UPDATE SET
       sha = excluded.sha,
       applied_at = CURRENT_TIMESTAMP`,
  );

  for (const step of ONSITE_MIGRATION_STEPS) {
    insert.run(step.name, step.sha);
  }
};

/**
 * List of migrations the current code declares. Each entry has a stable
 * `name` (used as the migrations_applied primary key) and a SHA-256 of the
 * SQL body (used by verifyMigrations).
 *
 * Adding a new migration: append a new entry here AND append the
 * corresponding `db.exec(...)` to the migrateAll transaction in runMigrations.
 * Changing the SQL body of an existing migration requires either bumping
 * the `name` or accepting that verifyMigrations will report it as corrupt
 * on the next startup.
 */
type MigrationStep = { name: string; sql: string; sha: string };

const sha256 = (sql: string): string =>
  createHash('sha256').update(sql, 'utf8').digest('hex');

/**
 * SHA-tracked migration steps. Only DDL statements with a stable SQL body
 * are listed here. ALTER steps that branch on PRAGMA introspection
 * (e.g. `addSessionsKindAndOnsiteColumns`) are deliberately excluded —
 * see the JSDoc on that function for why SQL hashing is unreliable for
 * those statements.
 *
 * Adding a new migration: append a new entry here AND append the
 * corresponding `db.exec(...)` to the migrateAll transaction in runMigrations.
 * Changing the SQL body of an existing migration requires either bumping
 * the `name` or accepting that verifyMigrations will report it as corrupt
 * on the next startup.
 *
 * Exported (read-only) for tests that pin the shape of this list.
 */
export const ONSITE_MIGRATION_STEPS: MigrationStep[] = [
  {
    name: '002_create_onsite_problems_table',
    sql: ONSITE_PROBLEMS_TABLE_SCHEMA_SQL,
    sha: '',
  },
  {
    name: '003_create_onsite_files_table',
    sql: ONSITE_FILES_TABLE_SCHEMA_SQL,
    sha: '',
  },
  {
    name: '004_create_onsite_state_audit_table',
    sql: ONSITE_STATE_AUDIT_TABLE_SCHEMA_SQL,
    sha: '',
  },
  {
    name: '005_create_onsite_discipline_log_table',
    sql: ONSITE_DISCIPLINE_LOG_TABLE_SCHEMA_SQL,
    sha: '',
  },
  {
    // Batch 5 (Sub-task E) cleanup: replace the Batch 4 best-effort
    // problem.json file-write hack with a real column. SHA-tracked because
    // the body is a fixed string (no PRAGMA introspection needed).
    name: '006_add_root_cause_text',
    sql: 'ALTER TABLE onsite_problems ADD COLUMN root_cause_text TEXT',
    sha: '',
  },
];

// Lazy SHA computation — done at module-load so the SHA reflects the *current*
// code. Any test or runtime startup that mutates the SQL constants above will
// see new SHAs and verifyMigrations will report drift.
for (const step of ONSITE_MIGRATION_STEPS) {
  if (!step.sha) {
    step.sha = sha256(step.sql);
  }
}
