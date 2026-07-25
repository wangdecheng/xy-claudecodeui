import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import JSZip from 'jszip';

import type { OnsiteFileKind } from '../../../shared/onsite-types.js';

export class PayloadTooLargeError extends Error {
  readonly code = 'PAYLOAD_TOO_LARGE';
  constructor(readonly size: number, readonly maxSize: number) {
    super(`Payload too large: ${size} bytes (max ${maxSize})`);
    this.name = 'PayloadTooLargeError';
  }
}

export class TooManyFilesError extends Error {
  readonly code = 'TOO_MANY_FILES';
  constructor(readonly count: number, readonly max: number) {
    super(`Too many files: ${count} (max ${max})`);
    this.name = 'TooManyFilesError';
  }
}

export type UploadedFile = {
  originalname: string;
  path: string;
  size: number;
  mimetype?: string;
};

export type UnpackResult =
  | { ok: true; originalName: string; unpackedDir: string; storedPath: string; size: number; kind: OnsiteFileKind }
  | { ok: false; originalName: string; error: string };

const MAX_UPLOAD_SIZE = 200 * 1024 * 1024;
const MAX_TOTAL_FILES = 20;
const MAX_EXPANDED_FILE_SIZE = 2 * 1024 * 1024 * 1024;
const MAX_BATCH_EXPANDED_SIZE = 5 * 1024 * 1024 * 1024;

export interface UnpackOptions {
  maxSingleSize?: number;
  maxTotalFiles?: number;
  maxExpandedFileSize?: number;
  maxBatchExpandedSize?: number;
}

type DetectedType = 'zip' | 'tar' | 'gzip' | 'png' | 'jpeg' | 'gif' | 'webp';

export async function unpackMany(
  files: UploadedFile[],
  destDir: string,
  options: UnpackOptions = {},
): Promise<UnpackResult[]> {
  const maxSingleSize = options.maxSingleSize ?? MAX_UPLOAD_SIZE;
  const maxTotalFiles = options.maxTotalFiles ?? MAX_TOTAL_FILES;
  const maxExpandedFileSize = options.maxExpandedFileSize ?? MAX_EXPANDED_FILE_SIZE;
  const maxBatchExpandedSize = options.maxBatchExpandedSize ?? MAX_BATCH_EXPANDED_SIZE;
  if (files.length === 0) return [];
  if (files.length > maxTotalFiles) throw new TooManyFilesError(files.length, maxTotalFiles);
  const oversized = files.find((file) => file.size > maxSingleSize);
  if (oversized) throw new PayloadTooLargeError(oversized.size, maxSingleSize);

  await mkdir(destDir, { recursive: true });
  let nextIndex = await nextUnpackedIndex(destDir);
  let batchSize = 0;
  const results: UnpackResult[] = [];

  for (const file of files) {
    const targetDir = path.join(destDir, `unpacked-${nextIndex}`);
    nextIndex += 1;
    try {
      const detected = await detectType(file);
      await mkdir(targetDir, { recursive: false });
      const { storedPath, kind } = await materialize(
        file,
        detected,
        targetDir,
        maxExpandedFileSize,
        maxBatchExpandedSize - batchSize,
      );
      await assertSafeTree(targetDir);
      const size = await treeSize(targetDir, maxExpandedFileSize);
      if (batchSize + size > maxBatchExpandedSize) {
        throw new Error('batch_expanded_size_exceeded');
      }
      batchSize += size;
      results.push({ ok: true, originalName: file.originalname, unpackedDir: targetDir, storedPath, size, kind });
    } catch (error: unknown) {
      await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
      results.push({ ok: false, originalName: file.originalname, error: classifyError(error) });
    }
  }
  return results;
}

async function nextUnpackedIndex(destDir: string): Promise<number> {
  const entries = await readdir(destDir, { withFileTypes: true }).catch(() => []);
  return entries.reduce((max, entry) => {
    const match = entry.isDirectory() ? /^unpacked-(\d+)$/.exec(entry.name) : null;
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
}

async function detectType(file: UploadedFile): Promise<DetectedType> {
  const name = file.originalname.toLowerCase();
  const header = Buffer.alloc(16);
  const stream = createReadStream(file.path, { start: 0, end: 15 });
  let offset = 0;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    buffer.copy(header, offset);
    offset += buffer.length;
  }
  if (name.endsWith('.zip')) {
    if (header.subarray(0, 2).equals(Buffer.from('PK'))) return 'zip';
    throw new Error('corrupted_archive');
  }
  if ((name.endsWith('.tar.gz') || name.endsWith('.tgz')) && header[0] === 0x1f && header[1] === 0x8b) return 'tar';
  if (name.endsWith('.gz') && header[0] === 0x1f && header[1] === 0x8b) return 'gzip';

  const mime = file.mimetype?.toLowerCase();
  if (name.endsWith('.png') && mime === 'image/png' && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if ((name.endsWith('.jpg') || name.endsWith('.jpeg')) && mime === 'image/jpeg' && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'jpeg';
  if (name.endsWith('.gif') && mime === 'image/gif' && /^GIF8[79]a/.test(header.toString('ascii', 0, 6))) return 'gif';
  if (name.endsWith('.webp') && mime === 'image/webp' && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new Error('unsupported_or_mismatched_file_type');
}

async function materialize(
  file: UploadedFile,
  type: DetectedType,
  targetDir: string,
  maxExpandedFileSize: number,
  maxRemainingBatchSize: number,
): Promise<{ storedPath: string; kind: OnsiteFileKind }> {
  if (type === 'zip') {
    const zip = await JSZip.loadAsync(await readFile(file.path), { checkCRC32: true, createFolders: true });
    let expanded = 0;
    for (const entry of Object.values(zip.files)) {
      if (entry.unsafeOriginalName) safeDestination(targetDir, entry.unsafeOriginalName);
      const destination = safeDestination(targetDir, entry.name);
      if (isZipSymlink(entry.unixPermissions)) throw new Error('dangerous_symlink');
      if (entry.dir) await mkdir(destination, { recursive: true });
      else {
        await mkdir(path.dirname(destination), { recursive: true });
        expanded += await streamToFile(
          entry.nodeStream('nodebuffer') as Readable,
          destination,
          maxExpandedFileSize,
          maxRemainingBatchSize - expanded,
        );
      }
    }
    return { storedPath: targetDir, kind: 'archive' };
  }
  if (type === 'tar') {
    const listing = await runCommand('tar', ['-tzf', file.path]);
    for (const entry of listing.split('\n').filter(Boolean)) safeDestination(targetDir, entry);
    const verbose = await runCommand('tar', ['-tvzf', file.path]);
    if (verbose.split('\n').some((line) => /^[lh]/.test(line))) throw new Error('dangerous_symlink');
    let expanded = 0;
    for (const line of verbose.split('\n').filter(Boolean)) {
      const size = tarEntrySize(line);
      if (size > maxExpandedFileSize) throw new Error('expanded_file_size_exceeded');
      expanded += size;
      if (expanded > maxRemainingBatchSize) throw new Error('batch_expanded_size_exceeded');
    }
    await runCommand('tar', ['-xzf', file.path, '-C', targetDir]);
    return { storedPath: targetDir, kind: 'archive' };
  }
  if (type === 'gzip') {
    const outputName = path.basename(file.originalname).replace(/\.gz$/i, '') || 'unpacked-file';
    const storedPath = safeDestination(targetDir, outputName);
    await streamToFile(
      createReadStream(file.path).pipe(createGunzip()),
      storedPath,
      maxExpandedFileSize,
      maxRemainingBatchSize,
    );
    return { storedPath, kind: 'gzip' };
  }
  const storedPath = safeDestination(targetDir, path.basename(file.originalname));
  await copyFile(file.path, storedPath);
  return { storedPath, kind: 'image' };
}

function tarEntrySize(line: string): number {
  const fields = line.trim().split(/\s+/);
  // BSD tar: mode link-count owner group size month day time name
  if (/^\d+$/.test(fields[1] ?? '') && /^\d+$/.test(fields[4] ?? '')) return Number(fields[4]);
  // GNU tar: mode owner/group size yyyy-mm-dd time name
  if (/^\d+$/.test(fields[2] ?? '')) return Number(fields[2]);
  throw new Error('invalid_tar_listing');
}

function isZipSymlink(permissions: number | string | null | undefined): boolean {
  const mode = typeof permissions === 'number'
    ? permissions
    : typeof permissions === 'string'
      ? Number.parseInt(permissions, 8)
      : 0;
  return (mode & 0o170000) === 0o120000;
}

async function streamToFile(source: Readable, destination: string, maxFileSize: number, maxBatchSize: number): Promise<number> {
  let written = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      if (written > maxFileSize) callback(new Error('expanded_file_size_exceeded'));
      else if (written > maxBatchSize) callback(new Error('batch_expanded_size_exceeded'));
      else callback(null, chunk);
    },
  });
  await pipeline(source, limiter, createWriteStream(destination, { flags: 'wx' }));
  return written;
}

function safeDestination(root: string, entryName: string): string {
  if (!entryName || path.isAbsolute(entryName) || /^[A-Za-z]:[\\/]/.test(entryName)) throw new Error('unsafe_archive_path');
  const destination = path.resolve(root, entryName);
  const relative = path.relative(path.resolve(root), destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe_archive_path');
  return destination;
}

async function assertSafeTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('dangerous_symlink');
    if (entry.isDirectory()) await assertSafeTree(path.join(root, entry.name));
  }
}

async function treeSize(root: string, maxFileSize: number): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) total += await treeSize(target, maxFileSize);
    else {
      const size = (await stat(target)).size;
      if (size > maxFileSize) throw new Error('expanded_file_size_exceeded');
      total += size;
    }
  }
  return total;
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} exit ${code}`)));
  });
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/corrupt|crc|zip|unexpected end|invalid/i.test(message)) return 'corrupted_archive';
  if (/unsafe_archive_path/.test(message)) return 'unsafe_archive_path';
  if (/dangerous_symlink/.test(message)) return 'dangerous_symlink';
  if (/expanded_file_size_exceeded/.test(message)) return 'expanded_file_size_exceeded';
  if (/batch_expanded_size_exceeded/.test(message)) return 'batch_expanded_size_exceeded';
  if (/unsupported_or_mismatched/.test(message)) return 'unsupported_or_mismatched_file_type';
  return `processing_failed: ${message}`;
}
