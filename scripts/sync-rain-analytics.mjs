/**
 * Pull Rain SDK analytics into Postgres (rain_sdk_cache).
 *
 * Examples:
 *   npm run rain:sync-analytics -- --wallet=0xYourAddress
 *   npm run rain:sync-analytics -- --leaderboard --protocol
 *   npm run rain:sync-analytics -- --wallet=0x... --leaderboard --protocol
 */
import pg from "pg";
import "../src/loadEnv.js";
import {
  syncLeaderboardCaches,
  syncProtocolStatsCache,
  syncWalletRainAnalytics,
} from "../src/services/rainAnalyticsSync.js";

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = { wallet: null, leaderboard: false, protocol: false, help: false };
  for (const a of argv) {
    if (a.startsWith("--wallet=")) out.wallet = a.slice("--wallet=".length).trim();
    else if (a === "--leaderboard") out.leaderboard = true;
    else if (a === "--protocol") out.protocol = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(`Usage: npm run rain:sync-analytics -- [options]

  --wallet=0x...   Sync positions, portfolio, transactions, PnL (subgraph) for wallet
  --leaderboard    Sync leaderboard (24h, 7d, 30d, all-time)
  --protocol       Sync protocol TVL / volume / market counts

If you pass no flags, runs --leaderboard and --protocol only.

Requires DATABASE_URL. Optional: SUBGRAPH_API_KEY for The Graph rate limits.
Match RAIN_ENVIRONMENT with your frontend (stage | development | production).`);
    process.exit(0);
  }

  if (!process.env.DATABASE_URL?.trim()) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  });

  try {
    const runWallet = !!args.wallet;
    const runGlobal = args.leaderboard || args.protocol;
    const defaultGlobal = !runWallet && !runGlobal;

    if (runWallet) {
      console.error(`[rain:sync] wallet ${args.wallet}`);
      const r = await syncWalletRainAnalytics(pool, args.wallet);
      console.log(JSON.stringify(r, null, 2));
    }

    if (args.leaderboard || defaultGlobal) {
      console.error("[rain:sync] leaderboard");
      const r = await syncLeaderboardCaches(pool);
      console.log(JSON.stringify(r, null, 2));
    }

    if (args.protocol || defaultGlobal) {
      console.error("[rain:sync] protocol");
      const r = await syncProtocolStatsCache(pool);
      console.log(JSON.stringify(r, null, 2));
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
