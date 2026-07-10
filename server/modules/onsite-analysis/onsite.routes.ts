/**
 * Onsite analysis routes — `/api/onsite/*`
 *
 * Authentication is applied at the server mount point
 * (`app.use('/api/onsite', authenticateToken, onsiteRoutes)` in `server/index.js`),
 * not per-handler, so every route under this prefix is protected.
 *
 * Endpoints (Batch 3 + 4 + 5):
 *  - GET  /api/onsite/config
 *  - GET  /api/onsite/problems
 *  - POST /api/onsite/problems
 *  - GET  /api/onsite/problems/:id
 *  - PATCH /api/onsite/problems/:id
 *  - POST /api/onsite/problems/:id/confirm-root-cause
 *  - POST /api/onsite/problems/:id/files         (Batch 5.4 — file upload)
 *  - GET  /api/onsite/problems/:id/files
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import express, { type Request, type Response } from 'express';
import multer from 'multer';

import { onsiteFilesDb } from '@/modules/database/repositories/onsite-files.db.js';
import { onsiteProblemsDb } from '@/modules/database/repositories/onsite-problems.db.js';
import { getConfig } from './config.service.js';
import { disciplineSofteningMiddleware } from './discipline/discipline-softening.middleware.js';
import {
  PayloadTooLargeError,
  TooManyFilesError,
  unpackMany,
  type UploadedFile,
} from './log-unpack.service.js';
import { onsiteBroadcast } from './onsite-broadcast.js';
import {
  CwdEscapeError,
  DescriptionRequiredError,
  ProblemRecord,
  problemService,
  sanitizeCustomerLabel,
} from './problem.service.js';
import { messagesStore, type StoredMessage } from './messages-store.service.js';
import { loadHistoryFromClaudeCode } from './claude-code-history.service.js';
import {
  InvalidStateTransitionError,
  ProblemNotFoundError,
  ReasonTooShortError,
  apply as applyState,
  type ProblemStatus,
} from './state-machine.service.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Multer upload (Batch 5.4) — diskStorage under os.tmpdir(), max 20 files,
// each ≤ 200MB. Per-batch size / count limits are enforced again in
// logUnpackService.unpackMany() so we can return structured 207/413 errors.
// ---------------------------------------------------------------------------

const uploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tmpdir()),
    filename: (_req, file, cb) => {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `onsite-upload-${uniqueSuffix}-${file.originalname}`);
    },
  }),
  limits: {
    fileSize: 200 * 1024 * 1024,
    files: 20,
  },
});

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
  description?: unknown;
};

router.post('/problems', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as CreateBody;

  // 1) 必给字段
  const missing: string[] = [];
  if (typeof body.customer !== 'string' || body.customer.length === 0) missing.push('customer');
  if (typeof body.iteration !== 'string' || body.iteration.length === 0) missing.push('iteration');
  if (typeof body.database !== 'string' || body.database.length === 0) missing.push('database');
  if (typeof body.cwd !== 'string' || body.cwd.length === 0) missing.push('cwd');
  if (typeof body.description !== 'string' || body.description.trim().length === 0) {
    missing.push('description');
  }

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
  const description = (body.description as string).trim();
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
  // userId 必传 (create 内会强转 sessions 表 user_id 列 NOT NULL)。
  // req.user 由 server/middleware/auth.js 的 authenticateToken 挂上,
  // 这里走 number 优先 + 字符串兜底, 与其他路由(confirm-root-cause 等)
  // 解析方式一致。
  type RequestWithUser = Request & { user?: { id?: string | number } };
  const userIdRaw = (req as RequestWithUser).user?.id;
  const userId =
    typeof userIdRaw === 'number'
      ? userIdRaw
      : typeof userIdRaw === 'string' && userIdRaw.length > 0
        ? Number(userIdRaw)
        : NaN;
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(401).json({
      error: 'AUTH_USER_ID_MISSING',
      message: 'authenticated user id is required to create an onsite problem',
    });
  }

  problemService
    .create({
      customer,
      third_bridge_branch: thirdBridgeBranch,
      iteration,
      database,
      cwd,
      description,
      userId,
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
      if (err instanceof DescriptionRequiredError) {
        return res.status(400).json({
          error: err.code,
          message: err.message,
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
// DELETE /api/onsite/problems/:id
// ---------------------------------------------------------------------------
//
// 物理删除一条 problem:磁盘目录(含 problem.json + 解压日志)+ DB 主表行
// (子表经 ON DELETE CASCADE 清空)+ 内存 ring buffer。成功后广播
// problems:changed,通知所有客户端重新拉列表。删除是不可逆操作,前端
// 走 window.confirm 二次确认。CwdEscapeError 翻译成 409(理论上 record
// 已经过创建期校验,这里是防御性二次校验)。

router.delete('/problems/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const result = await problemService.remove(id);
    if (!result.deleted) {
      return res.status(404).json({ error: 'PROBLEM_NOT_FOUND', message: `Problem not found: ${id}` });
    }
    onsiteBroadcast.broadcast({ type: 'problems:changed' });
    res.json({ id: result.id, deleted: true });
  } catch (error: unknown) {
    if (error instanceof CwdEscapeError) {
      return res.status(409).json({
        error: 'CWD_ESCAPE',
        message: error.message,
        cwd: error.cwd,
        root: error.root,
      });
    }
    const message = error instanceof Error ? error.message : 'delete failed';
    res.status(500).json({ error: 'DELETE_FAILED', message });
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
// POST /api/onsite/problems/:id/confirm-root-cause (Batch 4.3)
// ---------------------------------------------------------------------------
//
// 在 problem 进入 'analyzing' 后,由分析师/工程师提交根因结论。
// 纪律闸门:含软化词 → 422 + words 列表(不调 StateMachine);
// reason < 8 字符 → 400。
// 通过 → StateMachine.apply(id, 'confirmed', reason, actorId) + broadcast。

type ConfirmRootCauseBody = {
  root_cause_text?: unknown;
  reason?: unknown;
};

router.post('/problems/:id/confirm-root-cause', (req: Request, res: Response) => {
  const id = req.params.id;
  const body = (req.body ?? {}) as ConfirmRootCauseBody;

  // 1) root_cause_text 非空
  if (typeof body.root_cause_text !== 'string' || body.root_cause_text.trim().length === 0) {
    return res.status(400).json({
      error: 'ROOT_CAUSE_TEXT_REQUIRED',
      message: 'root_cause_text is required and must be a non-empty string',
    });
  }

  // 2) reason ≥ 8 字符(用 state-machine 的 MIN_REASON_LENGTH 校验一致)
  if (typeof body.reason !== 'string' || body.reason.trim().length < 8) {
    return res.status(400).json({
      error: 'REASON_TOO_SHORT',
      message: 'reason is required and must be at least 8 characters after trim',
      minLength: 8,
    });
  }

  const rootCauseText = body.root_cause_text as string;
  const reason = body.reason as string;
  const actorId =
    typeof (req as Request & { user?: { id?: string | number } }).user?.id === 'string' ||
    typeof (req as Request & { user?: { id?: string | number } }).user?.id === 'number'
      ? String((req as Request & { user?: { id?: string | number } }).user!.id)
      : null;

  // 3) 软化词闸门 — 命中 → 422,不调 StateMachine
  const matches = disciplineSofteningMiddleware.findWords(rootCauseText);
  if (matches.length > 0) {
    return res.status(422).json({
      error: 'softening_words_present',
      message: 'root_cause_text 包含软化词,请改用确定性结论',
      words: matches.map((m) => ({ word: m.word, position: m.position })),
    });
  }

  // 4) StateMachine.apply → 事务化迁移 analyzing → confirmed + audit + problem.json
  applyState(id, 'confirmed', reason, actorId)
    .then((result) => {
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

      // 把 root_cause_text 落库(后续 UI/审计读用)
      try {
        onsiteProblemsDb.updateRootCause(id, rootCauseText);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[confirm-root-cause] failed to persist root_cause_text for ${id}: ${message}`);
      }

      res.json({ ...result, root_cause_text: rootCauseText });
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
      const message = err instanceof Error ? err.message : 'confirm-root-cause failed';
      res.status(500).json({ error: 'CONFIRM_ROOT_CAUSE_FAILED', message });
    });
});

// ---------------------------------------------------------------------------
// POST /api/onsite/problems/:id/files (Batch 5.4)
// ---------------------------------------------------------------------------
//
// 接收 multipart 上传(form 字段名 `files`,最多 20 个文件,单文件 ≤ 200MB)。
// 每个 zip 解压到 <problem.cwd>/unpacked-N/,N 从 1 起;损坏 zip → 该项
// { ok: false, error: 'corrupted_zip' },其他项继续。
// 整批成功或部分成功 → 207 multi-status,含 per-file results。
// 单包超大 / 总数超限 → 413。

router.post('/problems/:id/files', (req, res, next) => {
  uploadMiddleware.array('files', 20)(req, res, (multerErr: unknown) => {
    if (multerErr) {
      const message = multerErr instanceof Error ? multerErr.message : String(multerErr);
      if (/LIMIT_FILE_SIZE/i.test(message)) {
        return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: '单文件超过 200MB 上限' });
      }
      if (/LIMIT_FILE_COUNT/i.test(message)) {
        return res.status(413).json({ error: 'TOO_MANY_FILES', message: '超过 20 文件上限' });
      }
      if (/LIMIT_UNEXPECTED_FILE/i.test(message)) {
        return res.status(400).json({ error: 'BAD_FIELD_NAME', message: '字段名必须是 files' });
      }
      return res.status(400).json({ error: 'UPLOAD_FAILED', message });
    }
    return handleFileUpload(req, res, next);
  });
});

async function handleFileUpload(req: Request, res: Response, _next: express.NextFunction): Promise<void> {
  const id = req.params.id;
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];

  if (files.length === 0) {
    res.status(400).json({ error: 'NO_FILES', message: '必须至少上传一个文件(form 字段名 files)' });
    return;
  }

  // 1) 校验 problem 存在 + 取 cwd
  let problem: ProblemRecord | null;
  try {
    problem = await problemService.getById(id);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'GET_PROBLEM_FAILED', message });
    return;
  }

  if (!problem) {
    res.status(404).json({ error: 'PROBLEM_NOT_FOUND', message: `Problem not found: ${id}` });
    return;
  }

  // 2) 调 logUnpackService 解压
  const inputs: UploadedFile[] = files.map((f) => ({
    originalname: f.originalname,
    path: f.path,
    size: f.size,
  }));

  let results;
  try {
    results = await unpackMany(inputs, problem.cwd);
  } catch (err: unknown) {
    // 整批失败
    if (err instanceof PayloadTooLargeError) {
      res.status(413).json({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof TooManyFilesError) {
      res.status(413).json({ error: err.code, message: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : 'unpack failed';
    res.status(500).json({ error: 'UNPACK_FAILED', message });
    return;
  }

  // 3) 成功的项落 onsite_files 表
  for (const r of results) {
    if (!r.ok) continue;
    const unpackedBase = r.unpackedDir.split('/').pop() ?? '';
    onsiteFilesDb.insert({
      id: randomUUID(),
      problem_id: problem.id,
      original_name: r.originalName,
      stored_path: `${problem.cwd}/${unpackedBase}`,
      size: r.size,
      kind: 'archive',
      unpacked_dir: r.unpackedDir,
    });
  }

  // 4) 207 multi-status
  res.status(207).json({
    results: results.map((r) => {
      if (r.ok) {
        return {
          ok: true,
          originalName: r.originalName,
          unpackedDir: r.unpackedDir,
          size: r.size,
        };
      }
      return { ok: false, originalName: r.originalName, error: r.error };
    }),
  });
}

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

// ---------------------------------------------------------------------------
// GET /api/onsite/problems/:id/messages (Batch 8 I1 + 磁盘回放)
// ---------------------------------------------------------------------------
//
// 返回该 problem 的 chat 消息,合并两个数据源(都按 ts 正序):
//  1. Claude Code CLI 磁盘 JSONL(主数据源,完整历史)
//  2. server 端 messagesStore(纯内存,补充磁盘尚未落盘的最新消息)
// 写入路径在 onsite-websocket.service.ts:attachHelloContext 包 ws.send。
// 401 由 mount 点 authenticateToken 处理。
//
// 重要:磁盘永远是主数据源。messagesStore 只捕获 server→client 的外发消息
// (assistant text / tool_use / tool_result),不包含用户消息。若 messagesStore
// 非空就跳过磁盘,用户消息和 tool_use(AskUserQuestion 等)会全部丢失。

router.get('/problems/:id/messages', async (req, res) => {
  const id = req.params.id;

  try {
    const problem = await problemService.getById(id);
    if (!problem) {
      return res.status(404).json({ error: 'PROBLEM_NOT_FOUND', message: `Problem not found: ${id}` });
    }
    const createdAtMs = problem.created_at ? Date.parse(problem.created_at) : 0;

    // 磁盘 JSONL 是主数据源(含用户消息 + assistant text + tool_use)
    let disk: StoredMessage[] = [];
    try {
      disk = await loadHistoryFromClaudeCode(id, problem.cwd, createdAtMs);
    } catch {
      // 读盘失败 → 回退到内存(不一定有数据,聊胜于无)
      disk = [];
    }

    // 内存 messagesStore 作为补充:只取比磁盘最新消息更新的(尚未落盘的部分)
    const memMessages = messagesStore.getByProblemId(id);
    const latestDiskTs = disk.length > 0 ? disk[disk.length - 1].ts : 0;
    const freshMem = memMessages.filter((m) => m.ts > latestDiskTs);

    // 合并并按 ts 升序
    const messages = [...disk, ...freshMem].sort((a, b) => a.ts - b.ts);

    res.json({ problem_id: id, messages });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'list messages failed';
    res.status(500).json({ error: 'LIST_MESSAGES_FAILED', message });
  }
});

export default router;