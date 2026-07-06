### Task 2.1 — DB schema 增量:5 张新表 + sessions 表加列

- **Modify** `server/modules/database/schema.ts:100-117`(`sessions` 表 CREATE):
  - 加 `kind TEXT NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat','onsite'))`
  - 加 `cwd TEXT`(onsite 才填)
  - 加 `third_bridge_branch TEXT`(onsite 才填)
  - 加 `iteration TEXT`
  - 加 `database TEXT`
  - 加索引 `idx_sessions_kind_cwd ON sessions(kind, cwd)`
- **Modify** `server/modules/database/schema.ts` — 新增以下 SQL 常量:
  - `ONSITE_PROBLEMS_TABLE_SCHEMA_SQL`(5 张表:problems / files / state_audit / discipline_log / problem_index)
  - 每个常量一个 CREATE TABLE,带 IF NOT EXISTS,主键 + 外键
- **Modify** `server/modules/database/migrations.ts:在 LAST_SCANNED_AT_SQL 之前` — 新增:
  - `addSessionsKindAndOnsiteColumns(db)` 函数:用 `PRAGMA table_info` 检查列,缺就 `ALTER TABLE ADD COLUMN`
  - `db.exec(ONSITE_PROBLEMS_TABLE_SCHEMA_SQL)` 五次
  - 各表索引 8 个
- **Test 写** `server/modules/database/tests/onsite-migration.test.ts`:
  ```ts
  test('迁移后 sessions 含 kind 列且默认 chat', () => {
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as any[];
    expect(cols.find(c => c.name === 'kind')).toBeDefined();
  });
  test('5 张新表全部存在', () => {
    for (const t of ['onsite_problems','onsite_files','onsite_state_audit','onsite_discipline_log']) {
      expect(tableExists(t)).toBe(true);
    }
  });
  ```
- **TDD** + **Commit**:`feat(onsite): DB schema + migration for 5 onsite tables and sessions.kind`

### Task 2.1.b — migration 事务包裹 + 启动时 schema 健康检查(防 C-4)

> **Why**:SQLite 的单条 `ALTER TABLE` / `CREATE TABLE` 自动提交,但**整个 `migrations.ts` 的执行不是原子的**——如果第 3 张表创建失败,前 2 张已落盘、`sessions` 表的 ALTER 已落盘,系统进入不一致状态,启动时 `PRAGMA table_info(sessions)` 可能读到半成品 schema。

- **Modify** `server/modules/database/migrations.ts`:
  - 整个迁移流程用 `db.transaction(() => { ... })()` 包裹(SQLite SAVEPOINT 嵌套事务,失败整体回滚)
  - 加 `migrations` 元表 `migrations_applied(id INTEGER PRIMARY KEY, name TEXT UNIQUE, sha TEXT NOT NULL, applied_at TEXT NOT NULL)`,每次执行前先写元数据行
  - 加 `verifyMigrations(db): { ok: true; version: number } | { ok: false; missing: string[]; corrupt: Array<{ name: string; expectedSha: string; actualSha: string }> }`:
    - 启动时跑 `PRAGMA user_version` + `SELECT name, sha FROM migrations_applied ORDER BY id`
    - 任一已记录 migration 的 sha 与当前代码期望不一致 → `corrupt`
    - 代码里有但 DB 没跑 → `missing`
  - 失败抛 `MigrationCorruptionError`,日志打印修复建议("回滚到上一个 good SHA,或清空 DB 后重跑")
  - `server/index.js` 启动流程最前面调用 `verifyMigrations(db)`,失败直接 `process.exit(1)` 不启服务
- **Test 写** `server/modules/database/tests/migration-rollback.test.ts`:
  ```ts
  test('第 3 张表创建失败 → 前 2 张也不存在(事务回滚)', async () => {
    const db = createTempDb();
    const stub = vi.spyOn(db, 'exec').mockImplementationOnce(realExec).mockImplementationOnce(realExec).mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => runMigrations(db)).toThrow();
    expect(tableExists(db, 'onsite_problems')).toBe(false); // 前 2 张也回滚
    expect(tableExists(db, 'onsite_files')).toBe(false);
  });
  test('verifyMigrations 检测 sha 不一致', () => {
    const db = createTempDb();
    runMigrations(db);
    db.prepare("UPDATE migrations_applied SET sha = 'corrupt' WHERE name = '001_onsite_tables'").run();
    const v = verifyMigrations(db);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.corrupt[0].name).toBe('001_onsite_tables');
  });
  ```
- **TDD** + **Commit**:`feat(onsite): migration transaction wrapper + integrity check`

### Task 2.2 — repositories CRUD

- **Create** `server/modules/database/repositories/onsite-problems.db.ts`
  - `insert(p: OnsiteProblemRecord): string`(返回 id)
  - `findById(id: string): OnsiteProblemRecord | null`
  - `findByCwd(cwd: string): OnsiteProblemRecord | null`
  - `list(): OnsiteProblemListItem[]`
  - `updateStatus(id, status, reason, actorId): void`
  - `updateMtime(id, mtime): void`
- **Create** `server/modules/database/repositories/onsite-files.db.ts` — 3 个 CRUD
- **Create** `server/modules/database/repositories/onsite-state-audit.db.ts` — append + list
- **Create** `server/modules/database/repositories/onsite-discipline-log.db.ts` — append + countByProblemId
- **Test 写**:每个 repository 一组 happy-path + boundary 测试
- **TDD**(每个文件单独) + **Commit**:`feat(onsite): 4 onsite repositories with CRUD tests`

### Task 2.3 — `ProblemService` 写盘与 cwd 越界防护

- **Create** `server/modules/onsite-analysis/problem.service.ts`:
  - `ONSITE_ROOT = path.join(os.homedir(), 'work/customer-onsite-analysis')`
  - `assertCwdUnderRoot(cwd: string): void` — 越界抛 `CwdEscapeError`(在 routes 转 403)
  - `create(dto): Promise<ProblemRecord>` — mkdir + write problem.json + INSERT 表,失败回滚
  - `list(): Promise<ProblemListItem[]>` — 扫目录 + 读 problem.json 或 fallback
  - `getById(id): Promise<ProblemRecord | null>`
  - `sanitizeCustomerLabel(s: string): string` — 替换 `/\\:*?"<>|` 为 `_`
- **Test 写**:
  ```ts
  test('create 写入 YYYYMMDD-客户 目录 + problem.json', async () => { ... });
  test('create 同日同客户重复 → 20260703-山西公安_2', async () => { ... });
  test('create cwd=/etc 越界 → 抛 CwdEscapeError', async () => { ... });
  test('list 跳过 docs/ 与 README.md', async () => { ... });
  test('list 兼容无 problem.json 的旧目录 → 默认 pending_info', async () => { ... });
  ```
- **TDD** + **Commit**:`feat(onsite): ProblemService with cwd guard and listing`

### Task 2.4 — `OnsiteWatcher` chokidar 监听

- **Create** `server/modules/onsite-analysis/onsiteWatcher.ts`:
  - 启动时初始化 chokidar 监听 `ONSITE_ROOT`
  - `add` / `unlink` / `change` 事件 debounce 1 秒后调 `list()` 并 emit `problems:changed` 事件
  - 接受 `onChange(cb): () => void`
- **Test 写**:用 `chokidar` 真实文件系统事件;`fs.mkdir` + `fs.writeFile` 触发,验证回调被调
- **TDD** + **Commit**:`feat(onsite): chokidar onsite watcher with 1s debounce`

---

## Batch 3:状态机 + 路由

> **目标**:`StateMachine` 与所有 REST 路由就绪;curl 即可验证。
> **依赖**:Batch 2(`ProblemService`)。

