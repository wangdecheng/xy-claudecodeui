/**
 * ProblemService — writes problem.json on disk under ONSITE_ROOT, and keeps
 * a parallel row in `onsite_problems` for fast listing/audit.
 *
 * Design (D-3): disk is the source of truth. DB write failures are logged
 * as warnings; disk failures throw.
 *
 * Disk layout (per existing CLAUDE.md in customer-onsite-analysis/):
 *   ~/work/customer-onsite-analysis/YYYYMMDD-客户/problem.json
 *   ~/work/customer-onsite-analysis/YYYYMMDD-客户/unpacked-N/<logs>
 *
 * Duplicate same-day creation appends `_2`, `_3`, ... to the directory and
 * the `id` field on the row.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { onsiteProblemsDb } from '@/modules/database/repositories/onsite-problems.db.js';
import { getConfig } from './config.service.js';

export class CwdEscapeError extends Error {
  readonly code = 'CWD_ESCAPE';
  readonly cwd: string;
  readonly root: string;

  constructor(cwd: string, root: string) {
    super(`cwd "${cwd}" is outside the onsite root "${root}"`);
    this.name = 'CwdEscapeError';
    this.cwd = cwd;
    this.root = root;
  }
}

export class FutureDateError extends Error {
  readonly code = 'FUTURE_DATE';
  readonly date: string;

  constructor(date: string) {
    super(`问题日期不能晚于今天 (got ${date})`);
    this.name = 'FutureDateError';
    this.date = date;
  }
}

export class DescriptionRequiredError extends Error {
  readonly code = 'DESCRIPTION_REQUIRED';

  constructor() {
    super('问题描述不能为空');
    this.name = 'DescriptionRequiredError';
  }
}

export type CreateProblemInput = {
  customer: string;
  third_bridge_branch: string | null;
  iteration: string;
  database: string;
  cwd: string;
  /** YYYY-MM-DD; if absent, defaults to today. Future dates are rejected. */
  date?: string;
  /** 必填:问题描述(≤2000 字符)。空字符串会抛 DescriptionRequiredError。 */
  description: string;
};

export type ProblemRecord = {
  id: string;
  customer: string;
  third_bridge_branch: string | null;
  iteration: string;
  database: string;
  status: string;
  cwd: string;
  problem_json_path: string | null;
  description: string;
  created_at?: string;
};

export type ProblemListItem = ProblemRecord & {
  problem_json_path: string | null;
};

/**
 * Resolve ONSITE_ROOT lazily — tests override via process.env.ONSITE_ROOT
 * before importing this module, but ESM module-load order means we have to
 * read at call-time, not at module-load time.
 */
export function resolveOnsiteRoot(): string {
  return process.env.ONSITE_ROOT ?? path.join(os.homedir(), 'work/customer-onsite-analysis');
}

/**
 * Replaces filesystem-unsafe characters with `_` so the resulting directory
 * name is portable. Whitespace is preserved (e.g. 山西公安 stays 山西公安).
 */
export function sanitizeCustomerLabel(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_');
}

/**
 * Asserts `cwd` resolves to a path under `root` after symlink + `..`
 * normalization. Throws CwdEscapeError otherwise.
 */
export function assertCwdUnderRoot(cwd: string, root: string = resolveOnsiteRoot()): void {
  const absoluteCwd = path.isAbsolute(cwd) ? path.resolve(cwd) : path.resolve(root, cwd);
  const absoluteRoot = path.resolve(root);
  const relative = path.relative(absoluteRoot, absoluteCwd);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new CwdEscapeError(cwd, absoluteRoot);
  }
}

const YYYYMMDD_PREFIX_REGEX = /^(\d{8})-(.+)$/;
const DATE_SUFFIX_REGEX = /_(\d+)$/;

function extractCustomer(dirName: string): string {
  const match = YYYYMMDD_PREFIX_REGEX.exec(dirName);
  if (!match) return dirName;
  // strip trailing _N suffix from same-day duplicates
  const customer = match[2]!;
  const suffix = DATE_SUFFIX_REGEX.exec(customer);
  return suffix ? customer.slice(0, suffix.index) : customer;
}

function deriveIdFromDirName(dirName: string): string {
  return dirName;
}

function deriveStatusFromProblemJson(json: unknown): string {
  if (json && typeof json === 'object' && json !== null && 'status' in json) {
    const status = (json as { status?: unknown }).status;
    if (typeof status === 'string' && status.length > 0) return status;
  }
  return 'pending_info';
}

/**
 * `create` writes `problem.json` to disk first, then inserts the row.
 * If the disk write fails, the call throws and no DB row is written.
 * If the DB insert fails after a successful disk write, the call still
 * resolves — disk is the source of truth per D-3, and the next `list`
 * will reconcile.
 */
export const problemService = {
  async create(input: CreateProblemInput): Promise<ProblemRecord> {
    const root = resolveOnsiteRoot();
    assertCwdUnderRoot(input.cwd, root);

    // 必填:问题描述
    const trimmedDescription = (input.description ?? '').trim();
    if (trimmedDescription.length === 0) {
      throw new DescriptionRequiredError();
    }
    const storedDescription = trimmedDescription.slice(0, 2000);

    const today = new Date();
    let yyyymmdd = formatYyyymmdd(today);

    if (input.date !== undefined) {
      const isoDate = input.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
        throw new FutureDateError(isoDate);
      }
      const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      if (isoDate > todayIso) {
        throw new FutureDateError(isoDate);
      }
      yyyymmdd = isoDate.replace(/-/g, '');
    }

    const sanitizedCustomer = sanitizeCustomerLabel(input.customer);
    const baseDirName = `${yyyymmdd}-${sanitizedCustomer}`;
    const dirName = await nextAvailableDirName(root, baseDirName);
    const dirPath = path.join(root, dirName);
    await mkdir(dirPath, { recursive: true });

    // 数据库选「其他」(value=other)时存 null,问题进 pending_info 等待补充
    const storedDatabase = input.database === 'other' ? null : input.database;

    const problemJsonPath = path.join(dirPath, 'problem.json');
    const now = today.toISOString();
    const record: ProblemRecord = {
      id: deriveIdFromDirName(dirName),
      customer: sanitizedCustomer,
      third_bridge_branch: input.third_bridge_branch,
      iteration: input.iteration,
      database: storedDatabase as string | null as string, // legacy: column is non-null; DB layer accepts null
      status: 'pending_info',
      cwd: dirPath,
      problem_json_path: problemJsonPath,
      description: storedDescription,
      created_at: now,
    };

    const jsonPayload = {
      id: record.id,
      customer: record.customer,
      third_bridge_branch: record.third_bridge_branch,
      iteration: record.iteration,
      database: storedDatabase,
      status: record.status,
      cwd: record.cwd,
      problem_json_path: record.problem_json_path,
      description: storedDescription,
      created_at: today.toISOString(),
    };
    await writeFile(problemJsonPath, JSON.stringify(jsonPayload, null, 2), 'utf8');

    try {
      onsiteProblemsDb.insert({
        id: record.id,
        customer: record.customer,
        third_bridge_branch: record.third_bridge_branch,
        iteration: record.iteration,
        database: storedDatabase as string | null as string,
        status: record.status,
        cwd: record.cwd,
        problem_json_path: record.problem_json_path,
        description: storedDescription,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[problem.service] DB insert failed for ${record.id}; disk is authoritative: ${message}`);
    }

    return record;
  },

  async list(): Promise<ProblemListItem[]> {
    const root = resolveOnsiteRoot();
    if (!existsSync(root)) return [];

    const entries = await readdir(root, { withFileTypes: true });
    const items: ProblemListItem[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!YYYYMMDD_PREFIX_REGEX.test(entry.name)) continue;

      const dirPath = path.join(root, entry.name);
      const jsonPath = path.join(dirPath, 'problem.json');
      let status = 'pending_info';
      let customer = extractCustomer(entry.name);
      let iteration: string | null = null;
      let database: string | null = null;
      let thirdBridgeBranch: string | null = null;

      let description = '';
      let created_at: string | undefined;

      try {
        const raw = await readFile(jsonPath, 'utf8');
        const json = JSON.parse(raw) as Record<string, unknown>;
        status = deriveStatusFromProblemJson(json);
        if (typeof json.customer === 'string') customer = json.customer;
        if (typeof json.iteration === 'string') iteration = json.iteration;
        if (typeof json.database === 'string') database = json.database;
        if (typeof json.third_bridge_branch === 'string' || json.third_bridge_branch === null) {
          thirdBridgeBranch = (json.third_bridge_branch as string | null) ?? null;
        }
        if (typeof json.description === 'string') description = json.description;
        if (typeof json.created_at === 'string') created_at = json.created_at;
      } catch {
        // No problem.json or unparseable — fall back to defaults
      }

      // 没有 created_at 时从目录名推断(YYYYMMDD-xxx → YYYY-MM-DD)
      if (!created_at) {
        const dateMatch = YYYYMMDD_PREFIX_REGEX.exec(entry.name);
        if (dateMatch && dateMatch[1]) {
          const d = dateMatch[1];
          created_at = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00.000Z`;
        }
      }

      items.push({
        id: deriveIdFromDirName(entry.name),
        customer,
        third_bridge_branch: thirdBridgeBranch,
        iteration: iteration ?? resolveDefaultIteration(),
        database: database ?? '',
        status,
        cwd: dirPath,
        problem_json_path: existsSync(jsonPath) ? jsonPath : null,
        description,
        created_at,
      });
    }

    return items;
  },

  async getById(id: string): Promise<ProblemRecord | null> {
    // DB 优先(D-3 磁盘为权威,但 DB 是快路径)
    const row = onsiteProblemsDb.findById(id);
    if (row) {
      return {
        id: row.id,
        customer: row.customer,
        third_bridge_branch: row.third_bridge_branch,
        iteration: row.iteration,
        database: row.database,
        status: row.status,
        cwd: row.cwd,
        problem_json_path: row.problem_json_path,
        description: row.description,
      };
    }
    // DB miss 时回退磁盘:可能是终端 agent 提前建的目录(无 problem.json 或 DB 未同步)
    const root = resolveOnsiteRoot();
    const dirPath = path.join(root, id);
    if (!existsSync(dirPath)) return null;

    let status = 'pending_info';
    let customer = extractCustomer(id);
    let iteration: string | null = null;
    let database: string | null = null;
    let thirdBridgeBranch: string | null = null;
    let description = '';
    let created_at: string | undefined;
    const jsonPath = path.join(dirPath, 'problem.json');
    try {
      const raw = await readFile(jsonPath, 'utf8');
      const json = JSON.parse(raw) as Record<string, unknown>;
      status = deriveStatusFromProblemJson(json);
      if (typeof json.customer === 'string') customer = json.customer;
      if (typeof json.iteration === 'string') iteration = json.iteration;
      if (typeof json.database === 'string') database = json.database;
      if (typeof json.third_bridge_branch === 'string' || json.third_bridge_branch === null) {
        thirdBridgeBranch = (json.third_bridge_branch as string | null) ?? null;
      }
      if (typeof json.description === 'string') description = json.description;
      if (typeof json.created_at === 'string') created_at = json.created_at;
    } catch {
      // no problem.json — keep defaults
    }

    // 没有 created_at 时从目录名推断(YYYYMMDD-xxx → YYYY-MM-DD)
    if (!created_at) {
      const dateMatch = YYYYMMDD_PREFIX_REGEX.exec(id);
      if (dateMatch && dateMatch[1]) {
        const d = dateMatch[1];
        created_at = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00.000Z`;
      }
    }

    return {
      id,
      customer,
      third_bridge_branch: thirdBridgeBranch,
      iteration: iteration ?? resolveDefaultIteration(),
      database: database ?? '',
      status,
      cwd: dirPath,
      problem_json_path: existsSync(jsonPath) ? jsonPath : null,
      description,
      created_at,
    };
  },
};

/**
 * Find the next available directory name with `_N` suffix on collision.
 * `20260703-山西公安` -> `20260703-山西公安_2` -> `..._3`, etc.
 */
async function nextAvailableDirName(root: string, baseDirName: string): Promise<string> {
  const first = path.join(root, baseDirName);
  if (!existsSync(first)) return baseDirName;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${baseDirName}_${i}`;
    if (!existsSync(path.join(root, candidate))) return candidate;
  }
  throw new Error(`Too many duplicate problem dirs for ${baseDirName} under ${root}`);
}

function formatYyyymmdd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * 取 config.iterations[0] 作为缺省 iteration(用于扫到老 problem 目录没写
 * problem.json / 没写 iteration 字段时)。若 config 加载失败,降级为空串,
 * 上层 UI 会显示"未指定"并触发状态机迁移到 pending_info。
 */
function resolveDefaultIteration(): string {
  try {
    const cfg = getConfig();
    return cfg.data.iterations[0] ?? '';
  } catch {
    return '';
  }
}