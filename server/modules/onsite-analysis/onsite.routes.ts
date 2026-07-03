/**
 * Onsite analysis routes — `GET /api/onsite/config` (and more to come in
 * later batches). Wraps the ConfigService for the front-end wizard.
 *
 * Authentication is applied at the server mount point
 * (`app.use('/api/onsite', authenticateToken, onsiteRoutes)` in `server/index.js`),
 * not per-handler, so every route under this prefix is protected.
 */

import express from 'express';

import { getConfig } from './config.service.js';

const router = express.Router();

router.get('/config', (_req, res) => {
  try {
    const cfg = getConfig();
    res.set('Cache-Control', 'no-store');
    res.json({
      status: cfg.status,
      mtime: cfg.mtime,
      data: cfg.data,
      error: cfg.error,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Config not available';
    res.status(503).json({ error: 'CONFIG_NOT_LOADED', message });
  }
});

export default router;