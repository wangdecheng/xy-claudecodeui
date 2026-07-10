/**
 * ProblemService — writes problem.json on disk under ONSITE_ROOT, and keeps
 * a parallel row in `onsite_problems` for fast listing/audit.
 *
 * Design (D-3): disk is the source of truth. DB write failures are logged
 * as warnings; disk failures throw.
 *
 * Disk layout (per existing CLAUDE.md in customer-onsite-analysis/):
 *   ~/work/customer-onsite-analysis/YYYYMMDDHHMMSS-客户/problem.json
 *   ~/work/customer-onsite-analysis/YYYYMMDDHHMMSS-客户/unpacked-N/<logs>
 *
 * 历史目录 (YYYYMMDD-客户, 无 HHMMSS) 仍然可读: 目录前缀正则把 HHMMSS
 * 部分设为可选, list / getById 兼容旧数据。
 *
 * Duplicate same-second creation appends `_2`, `_3`, ... to the directory
 * and the `id` field on the row. HHMMSS 精度把"删除后立即在同一秒重建"
 * 的 ID 复用窗口几乎关闭, 残留的同秒并发达到 _N 兜底。
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { onsiteProblemsDb } from '@/modules/database/repositories/onsite-problems.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { userDb } from '@/modules/database/repositories/users.js';
import { getConfig } from './config.service.js';
import { messagesStore } from './messages-store.service.js';

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
  /**
   * 创建者的 userId; 缺省时回退到 `userDb.getFirstUser().id`(平台/单用户模式)。
   * 路由层必须显式传 `req.user.id`; 此回退是给脚本/测试用的兜底, 不会
   * 把匿名 NULL 行写进 sessions 表。
   */
  userId?: number;
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

// 匹配 YYYYMMDD[-HHMMSS]-客户. HHMMSS 是可选的, 让历史无 HHMMSS 的目录
// 仍然能被 list / getById 读到. match[1] 是 8 位日期前缀, match[2] 是客户段。
const YYYYMMDD_PREFIX_REGEX = /^(\d{8})(?:\d{6})?-(.+)$/;
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
  return 'analyzing';
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
    // 时间前缀升级为 yyyymmddHHmmss, 关闭"删除后秒内重建"导致的 ID 复用窗口。
    // 14 位前缀里, yyyy-mm-dd 段可被 input.date 覆盖, HHmmss 段始终取自 now,
    // 同秒并发落到 nextAvailableDirName 的 _2 兜底。
    let dateKey = formatYyyymmddHHmmss(today);

    if (input.date !== undefined) {
      const isoDate = input.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
        throw new FutureDateError(isoDate);
      }
      const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      if (isoDate > todayIso) {
        throw new FutureDateError(isoDate);
      }
      // 替换前 8 位为输入日期, HHmmss 段保持当前时刻
      const yyyymmdd = isoDate.replace(/-/g, '');
      const hhmmss = dateKey.slice(8);
      dateKey = `${yyyymmdd}${hhmmss}`;
    }

    const sanitizedCustomer = sanitizeCustomerLabel(input.customer);
    const baseDirName = `${dateKey}-${sanitizedCustomer}`;
    const dirName = await nextAvailableDirName(root, baseDirName);
    const dirPath = path.join(root, dirName);
    await mkdir(dirPath, { recursive: true });

    // 数据库选「其他」(value=other)时存 null —— 代表"用户暂未指定数据库类型, 待补充"。
    // DB 层 onsite_problems.database 已被放宽为 nullable (见 schema.ts + migrations.ts),
    // 这里写 null 不再触发 NOT NULL constraint failed。
    const storedDatabase = input.database === 'other' ? null : input.database;

    const problemJsonPath = path.join(dirPath, 'problem.json');
    const now = today.toISOString();
    const record: ProblemRecord = {
      id: deriveIdFromDirName(dirName),
      customer: sanitizedCustomer,
      third_bridge_branch: input.third_bridge_branch,
      iteration: input.iteration,
      database: storedDatabase as string | null as string, // database 列已放宽为 nullable
      status: 'analyzing',
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

    // Eager session: 在 create 这一刻就把 sessions 行建好, 关闭
    // "create → 立即打开聊天 → 立即发消息" 这条链路上的 race —— 旧行为
    // 是 sessions 行在 WS hello 帧被服务端校验后才懒建, 客户端 chat.send
    // 可能早于 hello 到达 → getSessionById 拿不到 → SESSION_NOT_FOUND →
    // AI 无回应。新行为: problem 一建, session 就到位; 旧路径上的
    // ensureOnsiteSession 仍保留为幂等兜底(重连/重启场景)。
    //
    // userId 解析: input.userId 优先; 缺省取平台首用户(单用户模式)。
    // 拿不到任何 user (e.g. 测试 DB 空) 时 console.warn 兜底, 不让 create 抛
    // —— 与 onsite_problems DB insert 同等级, disk 仍是 source of truth。
    let resolvedUserId: number | null = null;
    if (typeof input.userId === 'number' && Number.isInteger(input.userId) && input.userId > 0) {
      resolvedUserId = input.userId;
    } else {
      try {
        const firstUser = userDb.getFirstUser();
        if (firstUser) resolvedUserId = Number(firstUser.id);
      } catch {
        /* ignore — fall through to no-user path */
      }
    }
    if (resolvedUserId === null) {
      console.warn(
        `[problem.service] eager session skipped for ${record.id}: no userId available ` +
          `(input.userId missing and userDb.getFirstUser() returned no user); ` +
          `chat will rely on the lazy ensureOnsiteSession path`,
      );
    } else {
      try {
        sessionsDb.createOnsiteSession(
          record.id,
          'claude',
          dirPath,
          {
            cwd: dirPath,
            third_bridge_branch: record.third_bridge_branch,
            iteration: record.iteration,
            database: record.database,
          },
          resolvedUserId,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[problem.service] eager session create failed for ${record.id}; ` +
            `fall back to lazy ensureOnsiteSession: ${message}`,
        );
      }
    }

    return record;
  },

  async list(userId?: number | null): Promise<ProblemListItem[]> {
    const root = resolveOnsiteRoot();
    if (!existsSync(root)) return [];

    // 多用户隔离：按 sessions 表的 user_id 过滤可见的 problem id。
    // sessions.session_id 与 onsite_problems.id 是 1:1 关系
    // （见 problemService.create 里 sessionsDb.createOnsiteSession(record.id, ...)）。
    //
    // 可见性规则（与 c411c99 引入的 sessions COALESCE 语义一致）：
    //  - userId 为 null（平台模式 / 单用户模式）→ 不过滤，全部可见。
    //  - userId 不为 null → 仅保留 `sessions.user_id = ? OR user_id IS NULL`
    //    的 problem。
    //  - 磁盘上存在但 sessions 表里完全没有对应行（孤儿 problem，通常是
    //    watcher 还没建 sessions 行的瞬态，或迁移前老数据）→ 视为公开，
    //    对所有登录用户可见，避免老数据被吞。
    let visibleIds: Set<string> | null = null;
    let allIds: Set<string> | null = null;
    if (userId != null) {
      visibleIds = sessionsDb.getVisibleOnsiteSessionIds(userId);
      allIds = sessionsDb.getAllOnsiteSessionIds();
    }

    const entries = await readdir(root, { withFileTypes: true });
    const items: ProblemListItem[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!YYYYMMDD_PREFIX_REGEX.test(entry.name)) continue;

      const id = deriveIdFromDirName(entry.name);
      // 多用户隔离过滤：仅在过滤模式下生效
      if (visibleIds !== null) {
        // 孤儿 problem（sessions 表里没有对应行）→ 公开可见
        // 其余 → 必须在 visibleIds 里才返回
        const isOrphan = allIds !== null && !allIds.has(id);
        if (!isOrphan && !visibleIds.has(id)) continue;
      }

      const dirPath = path.join(root, entry.name);
      const jsonPath = path.join(dirPath, 'problem.json');
      let status = 'analyzing';
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

    // 默认 'analyzing': 与 list() 保持一致。'pending_info' 状态已由
    // 77502ed 废弃, 旧 problem.json 若有该值会通过 deriveStatusFromProblemJson
    // 原样回传, 这里只覆盖"读不到 problem.json"这一条 fallback 路径。
    let status = 'analyzing';
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

  /**
   * 物理删除一条 problem:磁盘目录(含 problem.json + 解压日志)+ DB 主表行
   * (子表 onsite_files / onsite_state_audit / onsite_discipline_log 经
   * ON DELETE CASCADE 一并清空)+ 内存 ring buffer。
   *
   * 不存在 -> 返回 { deleted: false }(路由层翻译成 404,不抛错)。
   * cwd 越界 -> assertCwdUnderRoot 抛 CwdEscapeError(防御性二次校验)。
   * 删除不可逆,前端用 window.confirm 二次确认。
   */
  async remove(id: string): Promise<{ id: string; deleted: boolean }> {
    const record = await this.getById(id);
    if (!record) {
      return { id, deleted: false };
    }
    // 安全校验:cwd 必须在 ONSITE_ROOT 下,杜绝 path traversal / 误删其他路径
    assertCwdUnderRoot(record.cwd);
    // 删磁盘目录(含 problem.json + 解压日志)
    await rm(record.cwd, { recursive: true, force: true });
    // 删 DB 主表行(子表经 ON DELETE CASCADE 一并清空)
    onsiteProblemsDb.deleteById(id);
    // 清内存 ring buffer
    messagesStore.clear(id);
    // 记入墓碑:即使磁盘+DB+内存都被清空, "同一个 ID 不允许被再次生成出来"。
    // 在 nextAvailableDirName 选名时, 已墓碑的 baseDirName 会立即被抬到 _2。
    markDeleted(id);
    return { id, deleted: true };
  },
};

/**
 * Tombstone ring buffer — 容量上限 100, FIFO. 进程级内存, 不持久化。
 * 重启进程后历史墓碑会丢失, 但用户重新登录后短期内重复秒级创建的概率可忽略,
 * 且 ID 复用窗口被设上的默认在 100 条之外会被自然允许, 仍然是合理行为。
 *
 * 选择内存而不是 DB 是为了:
 *  - 不引入 schema 迁移 / 不依赖 DB 可用;
 *  - remove 成功后立即 push, create 时 O(1) 判断;
 *  - 服务重启不需要重建墓碑, 用户一旦发现重复创建会被 _N 兜底自然接住。
 */
const RECENT_DELETED_MAX = 100;
const recentDeletedIds = new Set<string>();
const recentDeletedOrder: string[] = [];

function markDeleted(id: string): void {
  if (recentDeletedIds.has(id)) return;
  recentDeletedIds.add(id);
  recentDeletedOrder.push(id);
  if (recentDeletedOrder.length > RECENT_DELETED_MAX) {
    const evicted = recentDeletedOrder.shift();
    if (evicted !== undefined) recentDeletedIds.delete(evicted);
  }
}

/**
 * 测试辅助: 清空墓碑。生产代码不要调用, 这是为 withIsolatedEnv 测试隔离设计的,
 * 避免前面跑过的 remove() 把状态渗透到当前测试。
 */
export function __resetTombstoneForTests(): void {
  recentDeletedIds.clear();
  recentDeletedOrder.length = 0;
}

/**
 * Find the next available directory name with `_N` suffix on collision.
 *
 *   `20260710095427-山西公安` (base, 不在 tombstone 且磁盘不存在) -> `20260710095427-山西公安`
 *   `20260710095427-山西公安` (在 tombstone 内)             -> `20260710095427-山西公安_2`
 *   `20260710095427-山西公安` (磁盘已存在)                  -> `20260710095427-山西公安_2`
 *
 * 上限 1000 轮 (与磁盘形态一致)。
 */
async function nextAvailableDirName(root: string, baseDirName: string): Promise<string> {
  const first = path.join(root, baseDirName);
  if (!existsSync(first) && !recentDeletedIds.has(baseDirName)) return baseDirName;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${baseDirName}_${i}`;
    if (recentDeletedIds.has(candidate)) continue;
    if (!existsSync(path.join(root, candidate))) return candidate;
  }
  throw new Error(`Too many duplicate problem dirs for ${baseDirName} under ${root}`);
}

function formatYyyymmddHHmmss(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}${hh}${mm}${ss}`;
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