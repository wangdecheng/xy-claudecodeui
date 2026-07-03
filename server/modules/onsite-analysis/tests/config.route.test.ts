/**
 * GET /api/onsite/config route tests.
 *
 * Run:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json server/modules/onsite-analysis/tests/config.route.test.ts
 */

import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import test from 'node:test';

// Import the router under test.
import onsiteRoutes from '../onsite.routes.js';
import {
  getConfig,
  loadConfig,
  resetConfig,
  _setConfigForTests,
  type ConfigPayload,
} from '../config.service.js';

const REPO_ROOT = process.cwd();
const GOOD_CONFIG = `${REPO_ROOT}/config/customer-analysis.json`;

function buildApp(): express.Express {
  const app = express();
  // Auth shim that injects a fake user so we don't need real JWT in tests.
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: number; username: string } }).user = {
      id: 1,
      username: 'tester',
    };
    next();
  });
  app.use('/api/onsite', onsiteRoutes);
  return app;
}

const samplePayload: ConfigPayload = {
  status: 'OK',
  mtime: new Date().toISOString(),
  data: {
    customers: [
      { label: '不涉及三方对接', branch: null },
      { label: '山西公安', branch: 'master_5.2_3.2' },
    ],
    iterations: ['release_5.2_3.2_20260327', 'master_5.2_3.2'],
  },
};

test.beforeEach(() => {
  resetConfig();
});

test('GET /api/onsite/config returns 200 + payload when loaded', async () => {
  await loadConfig(GOOD_CONFIG);
  const app = buildApp();

  const response = await request(app).get('/api/onsite/config');

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'OK');
  assert.ok(Array.isArray(response.body.data.customers));
  assert.ok(response.body.data.customers.length >= 13);
  assert.equal(response.body.data.customers[0].label, '不涉及三方对接');
  assert.equal(response.body.data.customers[0].branch, null);
  assert.equal(response.body.data.iterations.length, 2);
});

test('GET /api/onsite/config sets Cache-Control: no-store header', async () => {
  _setConfigForTests(samplePayload);
  const app = buildApp();

  const response = await request(app).get('/api/onsite/config');

  assert.equal(response.status, 200);
  assert.match(response.headers['cache-control'] || '', /no-store/);
});

test('GET /api/onsite/config returns 503/500 when config not loaded', async () => {
  resetConfig();
  const app = buildApp();

  const response = await request(app).get('/api/onsite/config');

  // Accept either 500 or a custom 503 — implementation choice. Must NOT be 200.
  assert.ok(response.status >= 500 && response.status < 600, `expected 5xx, got ${response.status}`);
  assert.ok(response.body.error || response.body.message);
});

test('GET /api/onsite/config requires authentication (401 without token)', async () => {
  // Build a separate app WITHOUT the auth shim and WITH the real auth middleware.
  const { authenticateToken } = await import('../../../middleware/auth.js');
  const app = express();
  app.use('/api/onsite', authenticateToken, onsiteRoutes);

  const response = await request(app).get('/api/onsite/config');

  assert.equal(response.status, 401);
  assert.match(response.body.error || '', /token|No token/i);
});