import { getConnection } from '@/modules/database/connection.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { normalizeProjectPath } from '@/shared/utils.js';

// ---------------------------------------------------------------------------
// I-9 fix: app-layer `kind` enforcement
// ---------------------------------------------------------------------------
//
// The sessions schema (`schema.ts:99-130`) declares
//   kind TEXT NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat','onsite'))
// — but the CHECK constraint only applies on fresh installs. Upgraded
// databases end up with a plain TEXT `kind` column and NO DB-level
// enforcement. A stray write of `'admin'` would silently succeed and
// later reads would treat it as a valid kind value.
//
// To close that gap, the repository guards every write through the
// `assertSessionKind(value)` runtime guard and surfaces a typed error
// (`InvalidSessionKindError`) so callers can `instanceof`-discriminate
// instead of relying on string matching.
//
// Batch 4 (WebSocket + child-spawn) will write `kind='onsite'` rows via
// `createOnsiteSession(...)`; Batch 5.5 (chat e2e) will rely on this
// guard to keep the `kind='chat'` filtering meaningful.

/**
 * The two valid session kinds. Aligned with the schema CHECK constraint
 * (`schema.ts:119`) and the onsite-migration test (`'bogus'` insert
 * rejected by SQLite on fresh installs).
 */
export type SessionKind = 'chat' | 'onsite';

export class InvalidSessionKindError extends Error {
  readonly code = 'INVALID_SESSION_KIND';
  readonly kind: unknown;
  constructor(kind: unknown) {
    super(
      `Invalid session kind: ${JSON.stringify(kind)} (must be 'chat' or 'onsite')`,
    );
    this.name = 'InvalidSessionKindError';
    this.kind = kind;
  }
}

/**
 * Throws `InvalidSessionKindError` if `value` is not exactly `'chat'` or
 * `'onsite'`. Use this immediately before any DB write that touches the
 * `kind` column so upgraded DBs (without a CHECK constraint) still
 * reject stray values at the application layer.
 */
export function assertSessionKind(value: unknown): asserts value is SessionKind {
  if (value !== 'chat' && value !== 'onsite') {
    throw new InvalidSessionKindError(value);
  }
}

// ---------------------------------------------------------------------------
// user_id 必传守卫
// ---------------------------------------------------------------------------
//
// `sessions.user_id` 列在 schema 里是 nullable 的（保留迁移前 NULL 旧数据的
// "公开可见" 语义），但仓库层三个 create 函数（createSession / createAppSession /
// createOnsiteSession）写入新行时**必须**绑定登录用户。文件系统同步器、HTTP
// 路由、onsite WS 任何一条写入路径漏传 userId 都会让历史 session 全部
// 变成 NULL，从而按 user_id 过滤时丢失——这就是 commit 7556c91 之后的
// "历史 session 无法按 user_id 过滤" 根因。
//
// `assertSessionUserId` 与 `InvalidSessionUserIdError` 是对称于
// `assertSessionKind` / `InvalidSessionKindError` 的实现：每个写入路径
// 在最前面调用一次即可，TypeScript 上把 userId 标成必填参数只是
// 编译期保险，runtime 仍需要这个守卫兜住 JS 侧 / 动态调用。
//
// COALESCE 语义保留：createSession 命中已有行时,旧 user_id 优先,新传
// 进来的 userId 不覆盖。这防止"另一用户在 watcher 路径下重新 upsert
// 同一行"时把归属偷走。

export class InvalidSessionUserIdError extends Error {
  readonly code = 'INVALID_SESSION_USER_ID';
  readonly userId: unknown;
  constructor(userId: unknown) {
    super(
      `Invalid session userId: ${JSON.stringify(userId)} (userId is required and must be coercible to a positive integer)`,
    );
    this.name = 'InvalidSessionUserIdError';
    this.userId = userId;
  }
}

/**
 * Throws `InvalidSessionUserIdError` if `value` is not coercible to a
 * positive integer. Used at the entry of every session-write helper so
 * legacy NULL rows can stay in the table for backwards compatibility
 * while new rows are guaranteed to be bound to a real user.
 */
export function assertSessionUserId(value: unknown): asserts value is number | string {
  if (value === null || value === undefined) {
    throw new InvalidSessionUserIdError(value);
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new InvalidSessionUserIdError(value);
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric <= 0) {
    throw new InvalidSessionUserIdError(value);
  }
}

/**
 * Onsite-only session options. `cwd` is the customer-analysis working
 * directory inside the project; the other three are NULL-able so
 * newer onsite features can populate them later without a schema bump.
 */
export type OnsiteSessionOptions = {
  cwd: string;
  third_bridge_branch: string | null;
  iteration: string;
  database: string;
};

type SessionRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
  jsonl_path: string | null;
  custom_name: string | null;
  isArchived: number;
  created_at: string;
  updated_at: string;
  user_id: number | null;
};

const SESSION_ROW_COLUMNS =
  'session_id, provider, provider_session_id, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at, user_id';

const SQLITE_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function normalizeTimestamp(value?: string): string | null {
  if (!value) return null;

  // SQLite CURRENT_TIMESTAMP is stored as UTC without a timezone suffix.
  // Normalize it here so every session reader returns canonical ISO strings
  // and the sidebar never interprets fresh rows as local-time "hours old".
  const normalizedValue = SQLITE_UTC_TIMESTAMP_REGEX.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;

  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function normalizeSessionRow<T extends SessionRow | null | undefined>(row: T): T {
  if (!row) {
    return row;
  }

  return {
    ...row,
    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,
    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,
  };
}

function normalizeSessionRows(rows: SessionRow[]): SessionRow[] {
  return rows.map((row) => normalizeSessionRow(row) as SessionRow);
}

function normalizeProjectPathForProvider(provider: string, projectPath: string): string {
  void provider;
  return normalizeProjectPath(projectPath);
}

export const sessionsDb = {
  /**
   * 查询会话的归属用户 ID。返回 null 表示公开会话（旧数据或无主）。
   */
  getSessionUserId(sessionId: string): number | null {
    const db = getConnection();
    const row = db
      .prepare('SELECT user_id FROM sessions WHERE session_id = ?')
      .get(sessionId) as { user_id: number | null } | undefined;
    return row?.user_id ?? null;
  },

  /**
   * Upserts one session row discovered on disk by a provider synchronizer.
   *
   * The given id is the provider-native session id. Rows are keyed by
   * `provider_session_id` so a session that was first created by the app
   * (with an app-allocated `session_id`) is updated in place once its
   * transcript shows up on disk, instead of producing a duplicate row.
   *
   * `userId` 必传：HTTP 路由传 req.user.id，文件系统 watcher 用
   * `usersDb.getFirstUser().id` 解析当前登录用户。任何调用方漏传
   * 都会被 `assertSessionUserId` 拦截（参见本文件顶部 user_id 守卫
   * 章节的注释），防止历史 session 因 user_id 为 NULL 而被按用户
   * 过滤掉。
   *
   * COALESCE 语义：命中已有行时保留旧 `user_id`（不覆盖归属），
   * 仅在新行写入时使用本次传入的 userId。
   */
  createSession(
    providerSessionId: string,
    provider: string,
    projectPath: string,
    userId: number | string,
    customName?: string,
    createdAt?: string,
    updatedAt?: string,
    jsonlPath?: string | null,
  ): string {
    const db = getConnection();
    // I-9 guard: chat is the historical default. We don't pass `kind` here
    // because the legacy call shape mustn't grow a new positional parameter;
    // instead we explicitly assert the intended kind so upgraded DBs
    // (without a CHECK constraint) still get the validation.
    assertSessionKind('chat');
    assertSessionUserId(userId);
    const createdAtValue = normalizeTimestamp(createdAt);
    const updatedAtValue = normalizeTimestamp(updatedAt);
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);
    const normalizedUserId = Number(userId);

    // First, ensure the project path is recorded in the projects table,
    // since it's a foreign key in the sessions table.
    projectsDb.createProjectPath(normalizedProjectPath);

    const existing = db
      .prepare(
        `SELECT session_id FROM sessions
         WHERE provider_session_id = ? AND provider = ?
         LIMIT 1`
      )
      .get(providerSessionId, provider) as { session_id: string } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE sessions SET
           provider = ?,
           updated_at = COALESCE(?, CURRENT_TIMESTAMP),
           project_path = ?,
           jsonl_path = ?,
           isArchived = 0,
           custom_name = COALESCE(?, custom_name)
         WHERE session_id = ?`
      ).run(
        provider,
        updatedAtValue,
        normalizedProjectPath,
        jsonlPath ?? null,
        customName ?? null,
        existing.session_id
      );

      return existing.session_id;
    }

    // Sessions created outside the app (directly via the provider CLI) are
    // keyed by the provider-native id for both columns. The ON CONFLICT path
    // covers legacy rows that predate the provider_session_id mapping.
    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at, user_id)
       VALUES (?, ?, ?, ?, ?, ?, 0, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP), ?)
       ON CONFLICT(session_id) DO UPDATE SET
         provider = excluded.provider,
         provider_session_id = excluded.provider_session_id,
         updated_at = excluded.updated_at,
         project_path = excluded.project_path,
         jsonl_path = excluded.jsonl_path,
         isArchived = 0,
         custom_name = COALESCE(excluded.custom_name, sessions.custom_name),
         user_id = COALESCE(sessions.user_id, excluded.user_id)`
    ).run(
      providerSessionId,
      provider,
      providerSessionId,
      customName ?? null,
      normalizedProjectPath,
      jsonlPath ?? null,
      createdAtValue,
      updatedAtValue,
      normalizedUserId,
    );

    return providerSessionId;
  },

  /**
   * Inserts one app-allocated session row before any provider run happens.
   *
   * The session gateway uses this when the frontend starts a brand-new chat:
   * `session_id` is the stable app-facing id, while `provider_session_id`
   * stays NULL until the provider runtime announces its own id and
   * `assignProviderSessionId` records the mapping.
   *
   * `userId` 必传（守卫见 assertSessionUserId）：来自 `req.user.id`，
   * session 一旦创建就锁定归属用户，后续 chat.send / fetchHistory /
   * delete / archive 都会用 `assertSessionOwnership` 校验当前用户
   * 与归属一致。
   */
  createAppSession(sessionId: string, provider: string, projectPath: string, userId: number | string): string {
    const db = getConnection();
    // I-9 guard: app-allocated sessions are always `kind='chat'` (the
    // historical chat path). Onsite sessions should use
    // `createOnsiteSession(...)` instead.
    assertSessionKind('chat');
    assertSessionUserId(userId);
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);
    const normalizedUserId = Number(userId);

    projectsDb.createProjectPath(normalizedProjectPath);

    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at, user_id)
       VALUES (?, ?, NULL, NULL, ?, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`
    ).run(sessionId, provider, normalizedProjectPath, normalizedUserId);

    return sessionId;
  },

  /**
   * Inserts a session row tagged `kind='onsite'` and populates the four
   * onsite-only columns (`cwd`, `third_bridge_branch`, `iteration`,
   * `database`). Used by Batch 4 (customer onsite child-process spawn).
   *
   * The repo enforces `kind='onsite'` at the application layer via
   * `assertSessionKind('onsite')` so upgraded DBs without the schema
   * CHECK still reject stray values. Forwards-looking risk per review:
   * Batch 5.5 chat e2e will rely on this row existing alongside chat rows
   * to verify that `kind` filtering works at the registry layer.
   *
   * `userId` 必传（守卫见 assertSessionUserId）：onsite hello frame 的
   * `userId` 字段在 websocket 入口已经过 `validateOnsiteHelloFrame` 校验
   * 类型，service 层拿到后强制要求非空，禁止 NULL 行。
   */
  createOnsiteSession(
    sessionId: string,
    provider: string,
    projectPath: string,
    options: OnsiteSessionOptions,
    userId: number | string,
  ): string {
    assertSessionKind('onsite');
    assertSessionUserId(userId);
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);
    const normalizedUserId = Number(userId);

    projectsDb.createProjectPath(normalizedProjectPath);

    db.prepare(
      `INSERT INTO sessions (
         session_id, provider, project_path, kind, cwd, third_bridge_branch, iteration, database,
         isArchived, created_at, updated_at, user_id
       ) VALUES (
         ?, ?, ?, 'onsite', ?, ?, ?, ?,
         0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?
       )`,
    ).run(
      sessionId,
      provider,
      normalizedProjectPath,
      options.cwd,
      options.third_bridge_branch,
      options.iteration,
      options.database,
      normalizedUserId,
    );

    return sessionId;
  },

  /**
   * Looks up the latest (by `updated_at`) onsite session whose `cwd`
   * matches the given path. Returns `null` when no such row exists.
   * Used by Batch 4 to dedupe the "session already running for cwd" path
   * before spawning a fresh child process.
   */
  findOnsiteSessionByCwd(cwd: string): SessionRow | null {
    const db = getConnection();
    // We have to project the full SESSION_ROW_COLUMNS list because the
    // return type is `SessionRow`, but we additionally constrain on
    // `kind='onsite'` and `cwd=?` for the lookup itself.
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE kind = 'onsite' AND cwd = ?
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT 1`,
      )
      .get(cwd) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * 返回当前登录用户可见的 onsite session_id 集合（用于 onsite problems
   * 列表按用户隔离过滤）。
   *
   * 语义与既有 `getSessionsByProjectPathAndUserId` 一致（参见 c411c99 引入
   * 的 COALESCE 约定）：
   * - `userId` 为 null 时不过滤（平台模式 / 单用户模式向后兼容）；
   * - `userId` 不为 null 时严格匹配 `user_id = ? OR user_id IS NULL`——
   *   登录用户只看到自己产生的 problem + 公开（NULL 历史行），看不到
   *   其他登录用户的 problem。
   *
   * 不在返回集合里的 session_id 不一定"私有"，也可能是 problem 还没建
   * sessions 行（孤儿）。调用方（problem.service.list）需要再做一次
   * "孤儿 vs 私有"的区分：私有用户的 sessions 行 + 当前用户不在
   * user_id 集合里 ⇒ 隐藏。
   */
  getVisibleOnsiteSessionIds(userId: number | null): Set<string> {
    const db = getConnection();
    const rows = userId == null
      ? (db
          .prepare(
            `SELECT session_id FROM sessions WHERE kind = 'onsite'`,
          )
          .all() as { session_id: string }[])
      : (db
          .prepare(
            `SELECT session_id FROM sessions
             WHERE kind = 'onsite'
               AND (user_id = ? OR user_id IS NULL)`,
          )
          .all(userId) as { session_id: string }[]);
    return new Set(rows.map((r) => r.session_id));
  },

  /**
   * 返回所有 onsite session_id 集合（不限 userId）。problem.service.list
   * 用来区分"孤儿 problem"（磁盘上有目录但 sessions 表里完全没有对应行）
   * 与"私有 problem"（sessions 行存在但当前用户不可见）。孤儿视为公开，
   * 私有用户的 sessions 行必须被过滤。
   */
  getAllOnsiteSessionIds(): Set<string> {
    const db = getConnection();
    const rows = db
      .prepare(`SELECT session_id FROM sessions WHERE kind = 'onsite'`)
      .all() as { session_id: string }[];
    return new Set(rows.map((r) => r.session_id));
  },

  /**
   * Records the provider-native session id for one app-allocated session.
   *
   * If the filesystem watcher indexed the provider transcript before this
   * mapping was recorded (a duplicate row keyed by the provider id exists),
   * the duplicate is merged into the app row: its transcript path and name
   * are adopted and the duplicate row is removed. Runs in a transaction so
   * the sidebar can never observe both rows at once.
   */
  assignProviderSessionId(sessionId: string, providerSessionId: string): void {
    const db = getConnection();

    const merge = db.transaction(() => {
      const duplicate = db
        .prepare(
          `SELECT ${SESSION_ROW_COLUMNS} FROM sessions
           WHERE (session_id = ? OR provider_session_id = ?)
             AND session_id <> ?
           LIMIT 1`
        )
        .get(providerSessionId, providerSessionId, sessionId) as SessionRow | undefined;

      if (duplicate) {
        db.prepare('DELETE FROM sessions WHERE session_id = ?').run(duplicate.session_id);
        db.prepare(
          `UPDATE sessions SET
             provider_session_id = ?,
             jsonl_path = COALESCE(jsonl_path, ?),
             custom_name = COALESCE(custom_name, ?),
             updated_at = CURRENT_TIMESTAMP
           WHERE session_id = ?`
        ).run(providerSessionId, duplicate.jsonl_path, duplicate.custom_name, sessionId);
        return;
      }

      db.prepare(
        `UPDATE sessions SET
           provider_session_id = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ?`
      ).run(providerSessionId, sessionId);

      // onsite session:把 session_id 从 problem.id 也改成 UUID,
      // 让后续 chat.send 和 CLI --resume 都指向同一 UUID session。
      const row = db
        .prepare('SELECT kind FROM sessions WHERE session_id = ?')
        .get(sessionId) as { kind?: string } | undefined;
      if (row?.kind === 'onsite' && sessionId !== providerSessionId) {
        db.prepare(
          'UPDATE sessions SET session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?'
        ).run(providerSessionId, sessionId);
      }
    });

    merge();
  },

  updateSessionCustomName(sessionId: string, customName: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET custom_name = ?
       WHERE session_id = ?`
    ).run(customName, sessionId);
  },

  getSessionById(sessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(sessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Resolves one session row through the provider-native id.
   *
   * The filesystem watcher only knows provider ids (they come from transcript
   * file names), so it uses this lookup to translate disk artifacts back to
   * the app-facing session row before broadcasting sidebar updates.
   */
  getSessionByProviderSessionId(providerSessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider_session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(providerSessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Finds the newest app-created session for a project that is still waiting
   * for its provider-native id to be recorded.
   *
   * Primary intention: OpenCode can expose a new session in its shared
   * `opencode.db` before the websocket runtime reports that same provider id
   * back to our app. At that moment the sidebar already has an optimistic
   * app-owned session row, but the watcher only knows the provider-native id.
   *
   * Without this lookup, the synchronizer would insert a second row keyed by
   * the provider id, then `assignProviderSessionId()` would merge it a moment
   * later. That eventually self-heals, but on slow networks the user can still
   * briefly see two sidebar sessions for the same conversation.
   *
   * This helper lets the synchronizer claim the pending app row first, so the
   * provider id is attached before any watcher-created row exists. The result
   * is simpler than frontend dedupe and keeps the race resolved at the source.
   */
  findLatestPendingAppSession(provider: string, projectPath: string): SessionRow | null {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider = ?
           AND project_path = ?
           AND provider_session_id IS NULL
           AND isArchived = 0
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT 1`
      )
      .get(provider, normalizedProjectPath) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  getAllSessions(): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 0`
      )
      .all() as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Archived rows are intentionally queried separately so the caller can render
   * them in a dedicated view without reintroducing them into active session lists.
   */
  getArchivedSessions(): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 1
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC`
      )
      .all() as SessionRow[];

    return normalizeSessionRows(rows);
  },

  getSessionsByProjectPath(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0`
      )
      .all(normalizedProjectPath) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Permanent project deletion must see every session row for the path,
   * including archived ones, so their transcript files can be cleaned up.
   */
  getSessionsByProjectPathIncludingArchived(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?`
      )
      .all(normalizedProjectPath) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * 按项目路径和用户过滤的会话查询（含归档）。
   *
   * 设计要点（与既有 `getSessionsByProjectPathAndUserId` 保持一致）：
   * - `userId` 为 null 时不过滤（单用户/平台模式向后兼容）；
   * - `userId` 不为 null 时严格匹配 `user_id = ? OR user_id IS NULL`——
   *   登录用户只看到自己产生的会话（active + archived）+ 公开（NULL 旧数据），
   *   看不到其他登录用户的会话。
   *
   * 用于 `/api/projects/archived` 这类"按用户隔离 + 包含归档"的视图。
   */
  getSessionsByProjectPathAndUserIdIncludingArchived(
    projectPath: string,
    userId: number | null,
  ): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = userId == null
      ? db.prepare(
          `SELECT ${SESSION_ROW_COLUMNS}
           FROM sessions
           WHERE project_path = ?
           ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC`,
        ).all(normalizedProjectPath) as SessionRow[]
      : db.prepare(
          `SELECT ${SESSION_ROW_COLUMNS}
           FROM sessions
           WHERE project_path = ?
             AND (user_id = ? OR user_id IS NULL)
           ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC`,
        ).all(normalizedProjectPath, userId) as SessionRow[];
    return normalizeSessionRows(rows);
  },

  getSessionsByProjectPathPage(projectPath: string, limit: number, offset: number): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(normalizedProjectPath, limit, offset) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  countSessionsByProjectPath(projectPath: string): number {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0`
      )
      .get(normalizedProjectPath) as { count: number } | undefined;

    return Number(row?.count ?? 0);
  },

  /**
   * 按项目路径和用户过滤的分页会话查询。
   * userId 为 null 时不过滤（兼容单用户模式）。
   */
  getSessionsByProjectPathAndUserId(
    projectPath: string,
    userId: number | null,
    limit: number,
    offset: number,
  ): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
           AND (user_id IS NULL OR ? IS NULL OR user_id = ?)
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(normalizedProjectPath, userId, userId, limit, offset) as SessionRow[];
    return normalizeSessionRows(rows);
  },

  /**
   * 按用户过滤的归档会话查询。
   */
  getArchivedSessionsByUserId(userId: number | null): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 1
           AND (user_id IS NULL OR ? IS NULL OR user_id = ?)
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC`
      )
      .all(userId, userId) as SessionRow[];
    return normalizeSessionRows(rows);
  },

  deleteSessionsByProjectPath(projectPath: string): void {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    db.prepare(`DELETE FROM sessions WHERE project_path = ?`).run(normalizedProjectPath);
  },

  getSessionName(sessionId: string, provider: string): string | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT custom_name
         FROM sessions
         WHERE session_id = ? AND provider = ?`
      )
      .get(sessionId, provider) as { custom_name: string | null } | undefined;

    return row?.custom_name ?? null;
  },

  /**
   * Soft-delete and restore both use the same flag update so callers keep the
   * row, metadata, and file path intact while toggling visibility.
   */
  updateSessionIsArchived(sessionId: string, isArchived: boolean): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET isArchived = ?
       WHERE session_id = ?`
    ).run(isArchived ? 1 : 0, sessionId);
  },

  deleteSessionById(sessionId: string): boolean {
    const db = getConnection();
    return db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId).changes > 0;
  },
};
