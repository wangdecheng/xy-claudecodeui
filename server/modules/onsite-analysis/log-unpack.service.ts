/**
 * log-unpack.service — 把上传的 zip 日志解压到问题目录下(Batch 5.3)。
 *
 * Spec:specs/discipline-write-protection.md REQ-10.x + design.md §D-7.1
 *
 * 设计:
 *  - 1 zip → 1 个 unpacked-N/ 目录(N 从 1 起)
 *  - 并行解压(每个 zip 一个 child_process)
 *  - 损坏 zip → 删除对应 unpacked-N/ 目录(回滚),返回 { ok: false, error }
 *  - 单包 > 200MB → PayloadTooLargeError(整批失败,不写任何文件)
 *  - 总数 > 20 → TooManyFilesError(整批失败,不写任何文件)
 *  - 实现用系统 `unzip` 命令(已在 macOS/Linux 预装)
 *
 * 注意:写入目录**必须是** destDir(unpacked-N 跟 destDir 同级),不能
 * 让 zip 内部 path traversal 跑到 destDir 外面。unzip 提供 -d 指定目标
 * 目录,我们用绝对路径 destDir/unpacked-N/。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export class PayloadTooLargeError extends Error {
  readonly code = 'PAYLOAD_TOO_LARGE';
  readonly size: number;
  readonly maxSize: number;

  constructor(size: number, maxSize: number) {
    super(`Payload too large: ${size} bytes (max ${maxSize})`);
    this.name = 'PayloadTooLargeError';
    this.size = size;
    this.maxSize = maxSize;
  }
}

export class TooManyFilesError extends Error {
  readonly code = 'TOO_MANY_FILES';
  readonly count: number;
  readonly max: number;

  constructor(count: number, max: number) {
    super(`Too many files: ${count} (max ${max})`);
    this.name = 'TooManyFilesError';
    this.count = count;
    this.max = max;
  }
}

export type UploadedFile = {
  originalname: string;
  path: string;
  size: number;
};

export type UnpackResult =
  | { ok: true; originalName: string; unpackedDir: string; size: number }
  | { ok: false; originalName: string; error: string };

const MAX_SINGLE_SIZE = 200 * 1024 * 1024; // 200MB
const MAX_TOTAL_FILES = 20;

interface UnpackOptions {
  /**
   * Override the single-file size limit. Tests pass `Number.MAX_SAFE_INTEGER`
   * to bypass the constant; production uses the default 200MB.
   */
  maxSingleSize?: number;
  /**
   * Override the per-batch file count limit. Tests may pin a smaller number
   * to exercise the cap without producing 21 real zips.
   */
  maxTotalFiles?: number;
}

/**
 * 把多个 zip 解压到 destDir/unpacked-1, destDir/unpacked-2, ...。
 *
 * 单包大小校验在解压前进行(全部 zip 都通过 → 才并行解压);
 * 损坏 zip → 单独返 { ok: false } + 删除对应目录。
 *
 * 失败语义:
 *  - 单包 > 200MB 或总数 > 20 → 整批失败(throw),已解压的目录会被回滚
 *  - 单个 zip 损坏 → 该项 { ok: false },其他项继续
 */
export async function unpackMany(
  files: UploadedFile[],
  destDir: string,
  options: UnpackOptions = {},
): Promise<UnpackResult[]> {
  const maxSingleSize = options.maxSingleSize !== undefined ? options.maxSingleSize : MAX_SINGLE_SIZE;
  const maxTotalFiles = options.maxTotalFiles !== undefined ? options.maxTotalFiles : MAX_TOTAL_FILES;

  if (files.length === 0) return [];

  // 1) 整批校验:总数 / 单包大小
  if (files.length > maxTotalFiles) {
    throw new TooManyFilesError(files.length, maxTotalFiles);
  }
  for (const f of files) {
    if (f.size > maxSingleSize) {
      // 整批失败,回滚任何已经创建的目录
      for (let i = 1; i <= files.length; i += 1) {
        await rm(path.join(destDir, `unpacked-${i}`), { recursive: true, force: true }).catch(() => undefined);
      }
      throw new PayloadTooLargeError(f.size, maxSingleSize);
    }
  }

  await mkdir(destDir, { recursive: true });

  // 2) 并行解压 — 每个 zip 一个 child_process.unzip
  const tasks = files.map((f, idx) => unpackOne(f, destDir, idx + 1));
  const settled = await Promise.allSettled(tasks);

  // 3) 转 UnpackResult 形式
  const results: UnpackResult[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]!;
    const r = settled[i]!;
    if (r.status === 'fulfilled') {
      results.push(r.value);
    } else {
      // 应该不会到这里(unpackOne 内部处理失败),但兜底
      results.push({ ok: false, originalName: file.originalname, error: String(r.reason) });
    }
  }

  return results;
}

async function unpackOne(
  file: UploadedFile,
  destDir: string,
  index: number,
): Promise<UnpackResult> {
  const targetDir = path.join(destDir, `unpacked-${index}`);
  await mkdir(targetDir, { recursive: true });

  try {
    await runUnzip(file.path, targetDir);

    // 解压成功 — 计算解压目录的总大小
    const size = await dirSize(targetDir);
    return { ok: true, originalName: file.originalname, unpackedDir: targetDir, size };
  } catch (err: unknown) {
    // 损坏 / 解压失败 → 删除目录(回滚),返回 { ok: false }
    await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      originalName: file.originalname,
      error: classifyError(message),
    };
  }
}

function classifyError(message: string): string {
  if (/cannot find|zipfile|invalid|bad|corrupt/i.test(message)) {
    return 'corrupted_zip';
  }
  return `unpack_failed: ${message}`;
}

/**
 * 用系统 `unzip` 把 zip 解到 targetDir。如果 unzip 退出码非 0,抛错。
 */
function runUnzip(zipPath: string, targetDir: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn('unzip', ['-q', '-o', zipPath, '-d', targetDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `unzip exit ${code}`));
    });
    proc.on('error', (err) => reject(err));
  });
}

/**
 * 累加目录里所有文件的总大小(bytes)。空目录返 0。
 * 浅层 — 不递归(本服务用于显示给 UI,精确数值不重要)。
 */
async function dirSize(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  const entries = await (await import('node:fs/promises')).readdir(dir, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    try {
      const s = await stat(p);
      total += s.size;
    } catch {
      /* skip — 文件可能已被删除 */
    }
  }
  return total;
}