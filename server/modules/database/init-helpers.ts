/**
 * Init wiring helpers — used by `server/index.js` (and any other entrypoint
 * that drives `initializeDatabase`) to discriminate a migration-integrity
 * failure from other init failures.
 *
 * Background (Batch 2 / C-4 patch):
 *   The C-4 patch wrapped `runMigrations` in a transaction and added a
 *   `verifyMigrations` SHA check at the end of `initializeDatabase`. When
 *   the SHA check fails we throw a `MigrationCorruptionError`.
 *
 *   That throw is the integrity alarm — the SQLite DB is no longer
 *   trustworthy (a recorded SHA drifted, or a step is missing). The brief
 *   requires that the server process refuses to start in that case
 *   (`process.exit(1)`) rather than booting up half-broken.
 *
 *   Wiring this in the JS startup is awkward because:
 *     1.  `MigrationCorruptionError` lives in a `.ts` file (the migration
 *         module) and the importer is `.js`. We want the discrimination to
 *         be cheap and tolerant, so we accept either `instanceof` matches
 *         OR a duck-typed `name === 'MigrationCorruptionError'`. The latter
 *         covers the case where the error was serialized over a process
 *         boundary or rebuilt from a log line.
 *     2.  `process.exit(1)` from the wiring point must be opt-in for the
 *         `MigrationCorruptionError` specifically — generic DB errors
 *         should still throw so the caller's existing error handler can
 *         decide what to do (CI/telemetry/sandbox scenarios).
 *
 *   These two helpers isolate that logic so it can be unit-tested without
 *   actually killing the test process.
 */

import { MigrationCorruptionError } from '@/modules/database/migrations.js';

/**
 * Detect `MigrationCorruptionError` either by `instanceof` (preferred) or
 * by duck-typed `name` (fallback for error objects reconstructed from logs
 * or process boundaries).
 *
 * The duck-typed fallback intentionally requires `err instanceof Error` —
 * that is, the error must have a real `Error` prototype. Otherwise a plain
 * `{ name: '...' }` object (e.g. from a JSON payload, a config literal,
 * or a misnamed thrown value) would be misclassified as a corruption event.
 */
export function isMigrationCorruptionError(err: unknown): boolean {
  if (err instanceof MigrationCorruptionError) return true;
  if (
    err instanceof Error &&
    (err as { name?: unknown }).name === 'MigrationCorruptionError'
  ) {
    return true;
  }
  return false;
}

/**
 * Wire this into the startup `try/catch` around `initializeDatabase()`:
 *
 *   try {
 *     await initializeDatabase();
 *   } catch (err) {
 *     handleMigrationCorruption(err); // exits(1) on corruption, else re-throws
 *   }
 *
 * Behaviour:
 *   - MigrationCorruptionError -> log a one-line red-alert message and
 *     call `exitFn(1)`. The return is `never`; the caller is responsible
 *     for ensuring the process actually leaves before any request can be
 *     served (the default `process.exit` satisfies this; tests inject a
 *     stub so the runner can keep going).
 *   - Any other thrown value -> re-thrown unchanged so existing error
 *     paths (CI sandbox, dev tooling, etc.) keep working.
 *
 * The `exitFn` argument defaults to `process.exit` for the production
 * wiring and is overridable in tests. Both function signatures accept any
 * callable that takes an exit code and doesn't return — we type it as
 * `(code?: number) => never` so the caller's contract stays honest.
 */
export function handleMigrationCorruption(
  err: unknown,
  exitFn: (code?: number) => never = process.exit.bind(process) as (
    code?: number,
  ) => never,
): never {
  if (isMigrationCorruptionError(err)) {
    const detail =
      err instanceof MigrationCorruptionError
        ? `missing=[${err.missing.join(', ')}], corrupt=${JSON.stringify(err.corrupt)}`
        : '(duck-typed)';
    // Use console.error so the line is visible in detached supervisors and
    // systemd journals without depending on a configured logger.
    console.error(
      `[FATAL] Migration integrity check failed — refusing to start server. ${detail}`,
    );
    exitFn(1);
  }
  throw err;
}
