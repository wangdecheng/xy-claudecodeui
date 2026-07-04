/**
 * Onsite analysis routes — `/api/onsite/*`
 *
 * Authentication is applied at the server mount point
 * (`app.use('/api/onsite', authenticateToken, onsiteRoutes)` in `server/index.js`),
 * not per-handler, so every route under this prefix is protected.
 *
 * Endpoints (Batch 3):
 *  - GET  /api/onsite/config
 *  - GET  /api/onsite/problems
 *  - POST /api/onsite/problems
 *  - GET  /api/onsite/problems/:id
 *  - PATCH /api/onsite/problems/:id
 *  - GET  /api/onsite/problems/:id/files
 */

import express, { type Request, type Response } from 'express';

import { onsiteFilesDb } from '@/modules/database/repositories/onsite-files.db.js';
import { getConfig } from './config.service.js';
import { onsiteBroadcast } from './onsite-broadcast.js';
import {
  CwdEscapeError,
  ProblemRecord,
  problemService,
  sanitizeCustomerLabel,
} from './problem.service.js';
import {
  InvalidStateTransitionError,
  ProblemNotFoundError,
  ReasonTooShortError,
  apply as applyState,
  type ProblemStatus,
} from './state-machine.service.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /config (Batch 1)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Status sort order — blocked → analyzing → pending_info → confirmed → abandoned
// ---------------------------------------------------------------------------

const STATUS_ORDER: Record<ProblemStatus, number> = {
  blocked: 0,
  analyzing: 1,
  pending_info: 2,
  confirmed: 3,
  abandoned: 4,
};

function compareStatus(a: string, b: string): number {
  const av = STATUS_ORDER[a as ProblemStatus] ?? 99;
  const bv = STATUS_ORDER[b as ProblemStatus] ?? 99;
  return av - bv;
}

// ---------------------------------------------------------------------------
// GET /api/onsite/problems
// ---------------------------------------------------------------------------

router.get('/problems', async (_req, res) => {
  try {
    const items = await problemService.list();
    const sorted = [...items].sort((a, b) => compareStatus(a.status, b.status));
    res.json({ problems: sorted });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'list failed';
    res.status(500).json({ error: 'LIST_FAILED', message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/onsite/problems
// ---------------------------------------------------------------------------

type CreateBody = {
  customer?: unknown;
  third_bridge_branch?: unknown;
  iteration?: unknown;
  database?: unknown;
  cwd?: unknown;
};

router.post('/problems', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as CreateBody;

  // 1) 必给字段
  const missing: string[] = [];
  if (typeof body.customer !== 'string' || body.customer.length === 0) missing.push('customer');
  if (typeof body.iteration !== 'string' || body.iteration.length === 0) missing.push('iteration');
  if (typeof body.database !== 'string' || body.database.length === 0) missing.push('database');
  if (typeof body.cwd !== 'string' || body.cwd.length === 0) missing.push('cwd');

  if (missing.length > 0) {
    return res.status(400).json({
      error: 'MISSING_FIELDS',
      message: `Missing required fields: ${missing.join(', ')}`,
      fields: missing,
    });
  }

  const customer = body.customer as string;
  const iteration = body.iteration as string;
  const database = body.database as string;
  const cwd = body.cwd as string;
  const thirdBridgeBranch =
    typeof body.third_bridge_branch === 'string' && body.third_bridge_branch.length > 0
      ? (body.third_bridge_branch as string)
      : null;

  // 2) customer 必须在 config.customers 里(sanitize 后比对)
  let cfg;
  try {
    cfg = getConfig();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'config not loaded';
    return res.status(503).json({ error: 'CONFIG_NOT_LOADED', message });
  }

  const sanitized = sanitizeCustomerLabel(customer);
  const matched = cfg.data.customers.some((c) => sanitizeCustomerLabel(c.label) === sanitized);
  if (!matched) {
    return res.status(422).json({
      error: 'CUSTOMER_NOT_IN_CONFIG',
      message: `Customer "${customer}" is not in the configured customers list`,
    });
  }

  // 3) 调 ProblemService.create — CwdEscapeError 翻译成 409
  problemService
    .create({
      customer,
      third_bridge_branch: thirdBridgeBranch,
      iteration,
      database,
      cwd,
    })
    .then((record: ProblemRecord) => {
      res.status(201).json(record);
    })
    .catch((err: unknown) => {
      if (err instanceof CwdEscapeError) {
        return res.status(409).json({
          error: 'CWD_ESCAPE',
          message: err.message,
          cwd: err.cwd,
          root: err.root,
        });
      }
      const message = err instanceof Error ? err.message : 'create failed';
      res.status(500).json({ error: 'CREATE_FAILED', message });
    });
});

// ---------------------------------------------------------------------------
// GET /api/onsite/problems/:id
// ---------------------------------------------------------------------------

router.get('/problems/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const record = await problemService.getById(id);
    if (!record) {
      return res.status(404).json({ error: 'PROBLEM_NOT_FOUND', message: `Problem not found: ${id}` });
    }
    res.json(record);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'getById failed';
    res.status(500).json({ error: 'GET_FAILED', message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/onsite/problems/:id
// ---------------------------------------------------------------------------

type PatchBody = {
  status?: unknown;
  reason?: unknown;
  actor_id?: unknown;
};

router.patch('/problems/:id', (req: Request, res: Response) => {
  const id = req.params.id;
  const body = (req.body ?? {}) as PatchBody;

  // 1) reason 必给且 ≥ 8 字符
  if (typeof body.reason !== 'string' || body.reason.trim().length < 8) {
    return res.status(400).json({
      error: 'REASON_TOO_SHORT',
      message: 'reason is required and must be at least 8 characters after trim',
    });
  }

  if (typeof body.status !== 'string') {
    return res.status(400).json({ error: 'INVALID_STATUS', message: 'status is required' });
  }

  const to = body.status as ProblemStatus;
  const reason = body.reason as string;
  const actorId =
    typeof body.actor_id === 'string' && body.actor_id.length > 0
      ? (body.actor_id as string)
      : null;

  applyState(id, to, reason, actorId)
    .then((result) => {
      // 成功 → broadcast state-changed
      onsiteBroadcast.broadcast({
        type: `problem:${id}:state-changed`,
        payload: {
          id,
          from: result.from,
          to: result.to,
          reason,
          at: result.at,
        },
      });

      res.json(result);
    })
    .catch((err: unknown) => {
      if (err instanceof ReasonTooShortError) {
        return res.status(400).json({
          error: err.code,
          message: err.message,
          minLength: err.minLength,
        });
      }
      if (err instanceof ProblemNotFoundError) {
        return res.status(404).json({ error: err.code, message: err.message });
      }
      if (err instanceof InvalidStateTransitionError) {
        return res.status(409).json({
          error: err.code,
          message: err.message,
          from: err.from,
          to: err.to,
          allowed: err.allowed,
        });
      }
      const message = err instanceof Error ? err.message : 'apply failed';
      res.status(500).json({ error: 'APPLY_FAILED', message });
    });
});

// ---------------------------------------------------------------------------
// GET /api/onsite/problems/:id/files
// ---------------------------------------------------------------------------

router.get('/problems/:id/files', async (req, res) => {
  const id = req.params.id;

  try {
    const problem = await problemService.getById(id);
    if (!problem) {
      return res.status(404).json({ error: 'PROBLEM_NOT_FOUND', message: `Problem not found: ${id}` });
    }
    const files = onsiteFilesDb.findByProblemId(id);
    res.json({ files });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'list files failed';
    res.status(500).json({ error: 'LIST_FILES_FAILED', message });
  }
});

export default router;