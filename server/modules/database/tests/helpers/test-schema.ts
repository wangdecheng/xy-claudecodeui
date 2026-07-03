/**
 * Test helpers — open an isolated SQLite database and apply the schema +
 * migrations in the same way the app would at startup.
 *
 * Reused by all migration / repository tests so we don't have to spin up the
 * real `initializeDatabase()` (which logs / throws in unexpected ways for
 * error-injection tests).
 */

import Database from 'better-sqlite3';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { INIT_SCHEMA_SQL } from '@/modules/database/schema.js';

export function initSchema(): Database.Database {
  const dbPath = process.env.DATABASE_PATH;
  if (!dbPath) {
    throw new Error('process.env.DATABASE_PATH must be set before calling initSchema()');
  }
  const db = new Database(dbPath);
  db.exec(INIT_SCHEMA_SQL);
  return db;
}

/**
 * Build a fresh connection, apply INIT_SCHEMA_SQL, then run migrations.
 * Returns the Database. Tests should `closeConnection()` afterwards.
 */
export function initSchemaWithMigrations(): Database.Database {
  // Reset module-level singleton state so connection.ts opens a fresh DB
  // for the env-var path set by the caller.
  closeConnection();
  const db = getConnection();
  db.exec(INIT_SCHEMA_SQL);
  runMigrations(db);
  return db;
}