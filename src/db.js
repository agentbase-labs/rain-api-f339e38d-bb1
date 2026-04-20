import "./loadEnv.js";
import pg from "pg";

const { Pool } = pg;

const dsn = String(process.env.DATABASE_URL || "").trim();

/** Only created when DATABASE_URL is set (SDK-only deploys skip Postgres entirely). */
export const pool = dsn
  ? new Pool({
      connectionString: dsn,
      ssl: dsn.includes("localhost") ? false : { rejectUnauthorized: false },
    })
  : null;

if (pool) {
  pool.on("error", (err) => console.error("PostgreSQL pool error:", err));
}
