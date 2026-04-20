import { Router } from 'express';

const router = Router();

router.post('/connect', (req, res) => {
  const { wallet_address, workflow_id } = req.body;
  if (!wallet_address) return res.status(400).json({ error: 'wallet_address required' });
  res.json({
    wallet_address: String(wallet_address).toLowerCase(),
    workflow_id: workflow_id || null,
    last_seen_at: new Date().toISOString(),
    note: 'SDK-only mode: user not persisted',
  });
});

router.get('/:address/participated-markets', (req, res) => {
  res.json([]);
});

router.get('/:address', (req, res) => {
  res.json({
    wallet_address: req.params.address.toLowerCase(),
    note: 'SDK-only mode: user not persisted',
  });
});

router.post('/:address/positions', (req, res) => {
  res.json({
    ok: true,
    note: 'SDK-only mode: position not persisted',
  });
});

router.get('/:address/positions', (req, res) => {
  res.json([]);
});

router.get('/:address/rain/analytics', (req, res) => {
  res.json({
    wallet: req.params.address.toLowerCase(),
    environment: process.env.RAIN_ENVIRONMENT || 'production',
    caches: {},
    note: 'SDK-only mode: no analytics cache (use Rain SDK client-side)',
  });
});

router.post('/:address/rain/analytics/sync', (req, res) => {
  res.status(501).json({
    error: 'Not available in SDK-only mode',
    note: 'Configure PostgreSQL + rain_sdk_cache or sync client-side',
  });
});

export default router;
