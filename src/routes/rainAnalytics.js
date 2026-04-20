import { Router } from "express";
import { pool } from "../db.js";
import { getRainEnvironment } from "../lib/rainClient.js";
import {
  syncLeaderboardCaches,
  syncProtocolStatsCache,
  syncWalletRainAnalytics,
} from "../services/rainAnalyticsSync.js";

const router = Router();

router.get("/cache/protocol", async (req, res) => {
  const env = getRainEnvironment();
  const { rows } = await pool.query(
    `SELECT payload, fetched_at, meta FROM rain_sdk_cache WHERE rain_environment = $1 AND cache_key = $2`,
    [env, "protocol:stats"],
  );
  if (!rows[0]) {
    return res.status(404).json({
      error: "No cached protocol stats. Run: npm run rain:sync-analytics -- --protocol",
    });
  }
  res.json({ ...rows[0].payload, fetched_at: rows[0].fetched_at, meta: rows[0].meta });
});

router.get("/cache/leaderboard", async (req, res) => {
  const timeframe = String(req.query.timeframe || "7d");
  const allowed = ["24h", "7d", "30d", "all-time"];
  if (!allowed.includes(timeframe)) {
    return res.status(400).json({ error: `timeframe must be one of: ${allowed.join(", ")}` });
  }
  const env = getRainEnvironment();
  const cacheKey = `leaderboard:${timeframe}:volume`;
  const { rows } = await pool.query(
    `SELECT payload, fetched_at, meta FROM rain_sdk_cache WHERE rain_environment = $1 AND cache_key = $2`,
    [env, cacheKey],
  );
  if (!rows[0]) {
    return res.status(404).json({
      error: `No cached leaderboard for ${timeframe}. Run: npm run rain:sync-analytics -- --leaderboard`,
    });
  }
  res.json({ ...rows[0].payload, fetched_at: rows[0].fetched_at, meta: rows[0].meta });
});

router.post("/sync/leaderboard", async (req, res) => {
  try {
    const out = await syncLeaderboardCaches(pool);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "sync failed" });
  }
});

router.post("/sync/protocol", async (req, res) => {
  try {
    const out = await syncProtocolStatsCache(pool);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "sync failed" });
  }
});

router.post("/sync/wallet", async (req, res) => {
  const wallet = req.body?.wallet || req.body?.address;
  if (!wallet || typeof wallet !== "string") {
    return res.status(400).json({ error: "body.wallet or body.address required" });
  }
  try {
    const out = await syncWalletRainAnalytics(pool, wallet);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "sync failed" });
  }
});

export default router;
