import { Router } from "express";
import { pool } from "../db.js";
import { getRainEnvironment } from "../lib/rainClient.js";
import { syncWalletRainAnalytics } from "../services/rainAnalyticsSync.js";

const router = Router();

function requirePool(req, res, next) {
  if (!pool) {
    return res.status(503).json({
      error: "PostgreSQL is not configured (SDK-only deploy). Use usersStub routes or provision DATABASE_URL.",
    });
  }
  next();
}

router.use(requirePool);

router.post("/connect", async (req, res) => {
  const { wallet_address, workflow_id } = req.body;
  if (!wallet_address) return res.status(400).json({ error: "wallet_address required" });

  const { rows } = await pool.query(
    `
    INSERT INTO users (wallet_address, workflow_id, last_seen_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (wallet_address) DO UPDATE SET
      last_seen_at = NOW(),
      workflow_id = COALESCE(EXCLUDED.workflow_id, users.workflow_id)
    RETURNING *
    `,
    [wallet_address.toLowerCase(), workflow_id || null],
  );

  res.json(rows[0]);
});

/** Distinct markets this wallet has a recorded position in (site DB). */
router.get("/:address/participated-markets", async (req, res) => {
  const w = req.params.address.toLowerCase();
  const { rows } = await pool.query(
    `
    SELECT DISTINCT ON (p.market_id)
      p.market_id,
      p.created_at AS last_position_at,
      m.question,
      m.description,
      m.options,
      m.tags,
      m.status,
      m.contract_address,
      m.country,
      m.liquidity_usdt,
      m.duration_days
    FROM positions p
    LEFT JOIN markets m ON m.market_id = p.market_id
    WHERE p.wallet_address = $1
    ORDER BY p.market_id, p.created_at DESC
    `,
    [w],
  );
  res.json(rows);
});

router.get("/:address", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM users WHERE wallet_address = $1", [
    req.params.address.toLowerCase(),
  ]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

router.post("/:address/positions", async (req, res) => {
  const { market_id, option_index, option_name, amount_usdt, transaction_hash } = req.body;
  const wallet_address = req.params.address.toLowerCase();

  const { rows } = await pool.query(
    `
    INSERT INTO positions (wallet_address, market_id, option_index, option_name, amount_usdt, transaction_hash)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (wallet_address, market_id, option_index)
    DO UPDATE SET amount_usdt = positions.amount_usdt + EXCLUDED.amount_usdt,
                  transaction_hash = EXCLUDED.transaction_hash
    RETURNING *
    `,
    [wallet_address, market_id, option_index, option_name, amount_usdt, transaction_hash],
  );

  res.json(rows[0]);
});

router.get("/:address/positions", async (req, res) => {
  const { rows } = await pool.query(
    `
    SELECT p.*, m.question, m.options, m.status
    FROM positions p
    LEFT JOIN markets m ON p.market_id = m.market_id
    WHERE p.wallet_address = $1
    ORDER BY p.created_at DESC
    `,
    [req.params.address.toLowerCase()],
  );
  res.json(rows);
});

/** Cached Rain SDK analytics (positions, portfolio, subgraph txs, PnL) for this wallet. */
router.get("/:address/rain/analytics", async (req, res) => {
  const w = req.params.address.toLowerCase();
  const env = getRainEnvironment();
  const { rows } = await pool.query(
    `
    SELECT cache_key, kind, payload, fetched_at, meta
    FROM rain_sdk_cache
    WHERE rain_environment = $1 AND wallet_address = $2
    ORDER BY kind
    `,
    [env, w],
  );
  const byKind = Object.fromEntries(
    rows.map((r) => [
      r.kind,
      { payload: r.payload, fetched_at: r.fetched_at, meta: r.meta, cache_key: r.cache_key },
    ]),
  );
  res.json({
    wallet: w,
    environment: env,
    caches: byKind,
  });
});

router.post("/:address/rain/analytics/sync", async (req, res) => {
  try {
    const out = await syncWalletRainAnalytics(pool, req.params.address);
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "sync failed" });
  }
});

export default router;
