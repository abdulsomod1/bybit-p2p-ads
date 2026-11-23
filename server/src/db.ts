
import pg, { type PoolClient } from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { logger } from "./logger.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl || undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: config.databaseUrl?.includes(".neon.tech")
    ? { rejectUnauthorized: true }
    : undefined,
});

function safeErrorDetails(
  error: unknown,
): { errorName: string; errorCode?: string } {
  const errorName = error instanceof Error ? error.name : "UnknownError";

  const errorCode =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;

  return errorCode ? { errorName, errorCode } : { errorName };
}

function validateDatabaseUrlTarget(): void {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }

  let target: URL;

  try {
    target = new URL(config.databaseUrl);
  } catch {
    throw new Error(
      "DATABASE_URL must be a valid PostgreSQL connection URL",
    );
  }

  const isPostgres =
    target.protocol === "postgresql:" ||
    target.protocol === "postgres:";

  const isNeon = target.hostname.endsWith(".neon.tech");

  const isLocal =
    ["localhost", "127.0.0.1", "[::1]", "postgres"].includes(
      target.hostname,
    );

  const validDatabase =
    target.pathname === "/neondb" ||
    target.pathname === "/bybit_p2p";

  if (
    !isPostgres ||
    (!isNeon && !isLocal) ||
    !validDatabase
  ) {
    throw new Error(
      "DATABASE_URL must point to an approved PostgreSQL database (Neon or local PostgreSQL)",
    );
  }

  if (isNeon && target.searchParams.get("sslmode") !== "require") {
    throw new Error(
      "Neon PostgreSQL requires sslmode=require",
    );
  }
}

async function verifyApplicationPermissions(): Promise<void> {
  const identity = await pool.query(
    `SELECT
       current_database() AS database_name,
       current_user AS role_name,
       role_info.rolsuper AS is_superuser,
       db_info.datdba = role_info.oid AS owns_database
     FROM pg_roles AS role_info
     JOIN pg_database AS db_info
       ON db_info.datname = current_database()
     WHERE role_info.rolname = current_user`,
  );

  const identityRow = identity.rows[0];

  const validDatabase =
    identityRow?.database_name === "neondb" ||
    identityRow?.database_name === "bybit_p2p";

  const validRole =
    identityRow?.role_name === "neondb_owner" ||
    identityRow?.role_name === "bybit_app";

  if (
    !identityRow ||
    !validDatabase ||
    !validRole ||
    identityRow.is_superuser
  ) {
    throw new Error(
      "Database identity verification failed. Use an approved non-superuser PostgreSQL role and database.",
    );
  }

  const tables = await pool.query(
    `SELECT
       table_name,
       has_table_privilege(
         current_user,
         format('public.%I', table_name),
         'SELECT'
       ) AS can_select,
       has_table_privilege(
         current_user,
         format('public.%I', table_name),
         'INSERT'
       ) AS can_insert
     FROM (VALUES
       ('users'),
       ('audit_events'),
       ('bot_operations'),
       ('p2p_scan_runs'),
       ('p2p_price_proposals'),
       ('p2p_live_control'),
       ('p2p_ad_repricing_configs')
     ) AS required_tables(table_name)`,
  );

  const missingTablePrivileges = tables.rows
    .filter((row) => !row.can_select || !row.can_insert)
    .map((row) => row.table_name as string);

  if (missingTablePrivileges.length) {
    throw new Error(
      `Missing SELECT/INSERT privileges on: ${missingTablePrivileges.join(", ")}`,
    );
  }

  const liveControlUpdate = await pool.query(
    `SELECT has_table_privilege(
       current_user,
       'public.p2p_live_control',
       'UPDATE'
     ) AS can_update`,
  );

  if (!liveControlUpdate.rows[0]?.can_update) {
    throw new Error(
      "Missing UPDATE privilege on public.p2p_live_control",
    );
  }

  const repricingUpdate = await pool.query(
    `SELECT
       has_table_privilege(
         current_user,
         'public.p2p_ad_repricing_configs',
         'UPDATE'
       ) AS config_update,
       has_table_privilege(
         current_user,
         'public.p2p_price_proposals',
         'UPDATE'
       ) AS proposals_update,
       has_table_privilege(
         current_user,
         'public.p2p_scan_runs',
         'UPDATE'
       ) AS scans_update`,
  );

  if (
    !repricingUpdate.rows[0]?.config_update ||
    !repricingUpdate.rows[0]?.proposals_update ||
    !repricingUpdate.rows[0]?.scans_update
  ) {
    throw new Error(
      "Missing UPDATE privilege on P2P repricing configuration, proposals, or scan metrics",
    );
  }

  const sequence = await pool.query(
    `SELECT
       has_sequence_privilege(
         current_user,
         'public.audit_events_id_seq',
         'USAGE'
       ) AS can_use,
       has_sequence_privilege(
         current_user,
         'public.audit_events_id_seq',
         'SELECT'
       ) AS can_select`,
  );

  if (
    !sequence.rows[0]?.can_use ||
    !sequence.rows[0]?.can_select
  ) {
    throw new Error(
      "Missing USAGE/SELECT privileges on public.audit_events_id_seq",
    );
  }

  const indexes = await pool.query(
    `SELECT
       to_regclass('public.idx_audit_events_created_at')
         IS NOT NULL AS audit_events_created_at,
       to_regclass('public.idx_bot_operations_status')
         IS NOT NULL AS bot_operations_status,
       to_regclass('public.idx_bot_operations_created_at')
         IS NOT NULL AS bot_operations_created_at`,
  );

  const indexRow = indexes.rows[0];

  if (
    !indexRow?.audit_events_created_at ||
    !indexRow?.bot_operations_status ||
    !indexRow?.bot_operations_created_at
  ) {
    throw new Error(
      "One or more required application indexes are missing",
    );
  }
}

export async function migrate(): Promise<void> {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }

  validateDatabaseUrlTarget();

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDirectory = path.resolve(
    currentDir,
    "../migrations",
  );

  logger.info(
    { migrationsDirectory },
    "Discovering database migrations",
  );

  let migrationFiles: string[];

  try {
    migrationFiles = fs
      .readdirSync(migrationsDirectory)
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort();
  } catch (error) {
    logger.error(
      {
        migrationsDirectory,
        ...safeErrorDetails(error),
      },
      "Failed to discover database migrations",
    );

    throw error;
  }

  logger.info(
    {
      migrationsDirectory,
      migrationFiles,
      count: migrationFiles.length,
    },
    "Database migrations discovered",
  );

  if (!migrationFiles.length) {
    logger.error(
      { migrationsDirectory },
      "No SQL migrations found",
    );

    throw new Error(
      `No SQL migrations found in ${migrationsDirectory}`,
    );
  }

  let client: PoolClient | undefined;
  let currentMigration: string | undefined;
  let transactionOpen = false;

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    transactionOpen = true;

    for (const migrationFile of migrationFiles) {
      currentMigration = migrationFile;

      logger.info(
        { migration: migrationFile },
        "Executing database migration",
      );

      const sql = fs.readFileSync(
        path.join(migrationsDirectory, migrationFile),
        "utf8",
      );

      await client.query(sql);

      logger.info(
        { migration: migrationFile },
        "Database migration executed",
      );
    }

    await client.query("COMMIT");
    transactionOpen = false;

    logger.info(
      { count: migrationFiles.length },
      "Database migrations committed",
    );
  } catch (error) {
    if (client && transactionOpen) {
      try {
        await client.query("ROLLBACK");

        logger.warn(
          { migration: currentMigration },
          "Database migration transaction rolled back",
        );
      } catch (rollbackError) {
        logger.error(
          {
            migration: currentMigration,
            ...safeErrorDetails(rollbackError),
          },
          "Failed to roll back database migration transaction",
        );
      }
    }

    logger.error(
      {
        migration: currentMigration,
        ...safeErrorDetails(error),
      },
      "Database migration failed",
    );

    throw error;
  } finally {
    client?.release();
  }

  try {
    await verifyApplicationPermissions();

    logger.info("Database permissions verified");
  } catch (error) {
    logger.error(
      safeErrorDetails(error),
      "Post-migration database verification failed",
    );

    throw error;
  }
}
