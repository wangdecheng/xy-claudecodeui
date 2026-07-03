import { getConnection } from "@/modules/database/connection.js";
import {
    MigrationCorruptionError,
    runMigrations,
    verifyMigrations,
} from "@/modules/database/migrations.js";
import { INIT_SCHEMA_SQL } from "@/modules/database/schema.js";

// Initialize database with schema
export const initializeDatabase = async () => {
    try {
        const db = getConnection();
        db.exec(INIT_SCHEMA_SQL);
        console.log('Database schema applied');
        runMigrations(db);

        // After migrations have applied, verify that the recorded SHAs match
        // the SHAs the current code declares. A drift means someone changed a
        // SQL constant without bumping the migration name — this is the
        // C-4 critical integrity check.
        const verification = verifyMigrations(db);
        if (!verification.ok) {
            const detail = [
                verification.missing.length > 0
                    ? `missing: [${verification.missing.join(', ')}]`
                    : null,
                verification.corrupt.length > 0
                    ? `corrupt: ${JSON.stringify(verification.corrupt)}`
                    : null,
            ]
                .filter(Boolean)
                .join('; ');
            const message = `Migration integrity check failed — ${detail}. Fix by either: (a) reverting the changed SQL constant, (b) bumping the migration name, or (c) if intentional, deleting the recorded sha from migrations_applied and re-running.`;
            console.error(message);
            throw new MigrationCorruptionError(
                message,
                verification.missing,
                verification.corrupt,
            );
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log('Database initialization failed', { error: message });
        throw err;
    }
};
