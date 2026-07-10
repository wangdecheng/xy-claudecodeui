/**
 * 回归测试: onsite_problems.database 的 NOT NULL 约束被放宽。
 *
 * 旧 schema 把 database 设为 NOT NULL, 但 ProblemService.create 在
 * `input.database === 'other'` 时存 null (代表"用户暂未指定")。两个语义
 * 直接冲突, DB insert 触发 NOT NULL constraint failed, 现场反馈流程
 * 走不通 (eager session 修复后这条报错更明显, 之前因 console.warn 兜底
 * 静默掉, 现场没察觉)。
 *
 * 修复: 迁移把 database 列放宽到 nullable。新 DB 走 schema.ts 的新定义;
 * 旧 DB 走 migrations.ts::dropOnsiteProblemsDatabaseNotNull (重建表去掉
 * NOT NULL, 数据保留, 索引重建)。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initSchemaWithMigrations } from './helpers/test-schema.js';

type ColumnInfo = { name: string; notnull: number; type: string };

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'onsite-db-nullable-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  initSchemaWithMigrations();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('onsite_problems.database 列允许 NULL (新 DB schema)', async () => {
  await withIsolatedDatabase(() => {
    const cols = getConnection()
      .prepare('PRAGMA table_info(onsite_problems)')
      .all() as ColumnInfo[];
    const dbCol = cols.find((c) => c.name === 'database');
    assert.ok(dbCol, 'onsite_problems.database 必须存在');
    assert.equal(dbCol.notnull, 0, 'database 列 notnull 应为 0 (允许 NULL)');
  });
});

test('onsite_problems.database 插入 NULL 不报错', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    db.prepare(
      `INSERT INTO onsite_problems
         (id, customer, iteration, database, status, cwd)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    ).run('p1', '山西公安', 'master_5.2_3.2', 'analyzing', '/tmp/p1');
    const row = db
      .prepare('SELECT database FROM onsite_problems WHERE id = ?')
      .get('p1') as { database: string | null };
    assert.equal(row.database, null);
  });
});

/**
 * 模拟"老 DB": 手工建一张 NOT NULL 的 onsite_problems, 跑迁移,
 * 验证 database 列从 NOT NULL → nullable, 数据完整保留, 索引重建。
 */
test('旧 DB 跑迁移后 database 从 NOT NULL 变 nullable, 数据不丢', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'onsite-db-legacy-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  // 1) 手工建一张老 schema 的 onsite_problems
  const legacyDb = new Database(databasePath);
  legacyDb.exec(`
    CREATE TABLE onsite_problems (
      id TEXT PRIMARY KEY,
      customer TEXT NOT NULL,
      third_bridge_branch TEXT,
      iteration TEXT NOT NULL,
      database TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'analyzing',
      cwd TEXT NOT NULL,
      problem_json_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      mtime TEXT,
      root_cause_text TEXT
    );
    INSERT INTO onsite_problems (id, customer, iteration, database, cwd)
      VALUES ('legacy-1', '山西公安', 'master_5.2_3.2', 'mysql', '/tmp/legacy-1');
  `);
  legacyDb.close();

  // 2) 跑全套迁移
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  initSchemaWithMigrations();

  try {
    const db = getConnection();

    // 3) 列变 nullable
    const cols = db
      .prepare('PRAGMA table_info(onsite_problems)')
      .all() as ColumnInfo[];
    const dbCol = cols.find((c) => c.name === 'database');
    assert.ok(dbCol);
    assert.equal(dbCol.notnull, 0, '迁移后 database 列应允许 NULL');

    // 4) 旧数据保留
    const row = db
      .prepare('SELECT id, customer, database FROM onsite_problems WHERE id = ?')
      .get('legacy-1') as { id: string; customer: string; database: string };
    assert.equal(row.id, 'legacy-1');
    assert.equal(row.customer, '山西公安');
    assert.equal(row.database, 'mysql');

    // 5) 现在可以插 NULL
    db.prepare(
      `INSERT INTO onsite_problems
         (id, customer, iteration, database, cwd)
       VALUES (?, ?, ?, NULL, ?)`,
    ).run('legacy-2', '其他问题', 'master_5.2_3.2', '/tmp/legacy-2');
    const row2 = db
      .prepare('SELECT database FROM onsite_problems WHERE id = ?')
      .get('legacy-2') as { database: string | null };
    assert.equal(row2.database, null);

    // 6) 索引重建 (DROP TABLE 把索引一起带走了)
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'onsite_problems'")
      .all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);
    assert.ok(indexNames.includes('idx_onsite_problems_cwd'), '索引 idx_onsite_problems_cwd 应重建');
    assert.ok(indexNames.includes('idx_onsite_problems_status'), '索引 idx_onsite_problems_status 应重建');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

/**
 * 幂等: 已 nullable 的 DB 再跑迁移是 no-op, 不应触发 CREATE/DROP。
 */
test('迁移幂等: nullable DB 再跑一次是 no-op', async () => {
  await withIsolatedDatabase(() => {
    // 已经 nullable (第一条测试已确认)
    // 重新打开连接, 再跑一次 initSchemaWithMigrations
    closeConnection();
    initSchemaWithMigrations();
    const cols = getConnection()
      .prepare('PRAGMA table_info(onsite_problems)')
      .all() as ColumnInfo[];
    const dbCol = cols.find((c) => c.name === 'database');
    assert.equal(dbCol?.notnull, 0, '第二次跑迁移后 database 仍应允许 NULL');
  });
});
