import { createRain, getRainEnvironment, getUsdtTokenAddress } from "../lib/rainClient.js";

/** @param {unknown} v */
export function serializeBigInts(v) {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(serializeBigInts);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, serializeBigInts(val)]));
  }
  return v;
}

function normAddr(a) {
  if (!a || typeof a !== "string") throw new Error("wallet address required");
  const s = a.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(s)) throw new Error("invalid wallet address");
  return s;
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ cacheKey: string, wallet: string | null, kind: string, payload: unknown, meta?: Record<string, unknown> }} p
 */
export async function upsertRainCache(pool, { cacheKey, wallet, kind, payload, meta = {} }) {
  const env = getRainEnvironment();
  await pool.query(
    `
    INSERT INTO rain_sdk_cache (cache_key, wallet_address, rain_environment, kind, payload, meta, fetched_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NOW())
    ON CONFLICT (cache_key, rain_environment) DO UPDATE SET
      wallet_address = EXCLUDED.wallet_address,
      kind = EXCLUDED.kind,
      payload = EXCLUDED.payload,
      meta = EXCLUDED.meta,
      fetched_at = NOW()
    `,
    [cacheKey, wallet, env, kind, JSON.stringify(serializeBigInts(payload)), JSON.stringify(meta)],
  );
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} walletAddress
 * @returns {Promise<{ steps: { kind: string, ok: boolean, error?: string }[] }>}
 */
export async function syncWalletRainAnalytics(pool, walletAddress) {
  const w = normAddr(walletAddress);
  const rain = createRain();
  const usdt = getUsdtTokenAddress();
  const steps = [];

  const run = async (kind, cacheKey, fn) => {
    try {
      const data = await fn();
      await upsertRainCache(pool, { cacheKey, wallet: w, kind, payload: data });
      steps.push({ kind, ok: true });
    } catch (e) {
      steps.push({ kind, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  await run("positions", `positions:${w}`, () => rain.getPositions(w));

  await run("portfolio", `portfolio:${w}`, () =>
    rain.getPortfolioValue({
      address: /** @type {`0x${string}`} */ (w),
      tokenAddresses: [/** @type {`0x${string}`} */ (usdt)],
    }),
  );

  await run("transactions", `transactions:${w}`, () =>
    rain.getTransactions({
      address: /** @type {`0x${string}`} */ (w),
      first: 80,
      skip: 0,
      orderDirection: "desc",
    }),
  );

  await run("pnl", `pnl:${w}`, () => rain.getPnL({ address: /** @type {`0x${string}`} */ (w) }));

  return { steps };
}

const LEADERBOARD_TIMEFRAMES = /** @type {const} */ (["24h", "7d", "30d", "all-time"]);

/**
 * @param {import('pg').Pool} pool
 */
export async function syncLeaderboardCaches(pool) {
  const rain = createRain();
  const steps = [];

  for (const timeframe of LEADERBOARD_TIMEFRAMES) {
    const kind = "leaderboard";
    const cacheKey = `leaderboard:${timeframe}:volume`;
    try {
      const data = await rain.getLeaderboard({
        timeframe,
        limit: 50,
        sortBy: "volume",
      });
      await upsertRainCache(pool, {
        cacheKey,
        wallet: null,
        kind,
        payload: data,
        meta: { timeframe, sortBy: "volume" },
      });
      steps.push({ kind, timeframe, ok: true });
    } catch (e) {
      steps.push({
        kind,
        timeframe,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { steps };
}

/**
 * @param {import('pg').Pool} pool
 */
export async function syncProtocolStatsCache(pool) {
  const rain = createRain();
  try {
    const data = await rain.getProtocolStats();
    await upsertRainCache(pool, {
      cacheKey: "protocol:stats",
      wallet: null,
      kind: "protocol_stats",
      payload: data,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
