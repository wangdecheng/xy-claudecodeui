/**
 * log-unpack.service — TDD tests for Sub-task C (Batch 5.3).
 *
 * Covers:
 *  - unpackMany([]) 返空数组
 *  - 3 个 zip 并行 → 3 个 unpacked-N 目录(N=1,2,3),无覆盖
 *  - 单包 > 200MB 抛 PayloadTooLargeError
 *  - 第 3 个 zip 损坏 → unpacked-3 不存在 + 该项 ok:false
 *  - 总数 > 20 抛 TooManyFilesError
 *  - 单 zip 1 文件 → unpacked-1 目录含解压文件
 *  - 解压失败 → 删除 unpacked-N 目录(回滚)
 *  - 损坏 zip 返回的 error 字符串包含 'corrupted' 提示
 *
 * Run:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
 *     server/modules/onsite-analysis/tests/log-unpack.test.ts
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PayloadTooLargeError,
  TooManyFilesError,
  unpackMany,
  type UploadedFile,
} from '../log-unpack.service.js';

// ---------------------------------------------------------------------------
// Helpers — 构造 zip 文件
// ---------------------------------------------------------------------------

/**
 * 用一段 minimal central-directory 的 byte 序列构造一个**合法但简单**的 zip。
 * 真正的 zip 解压我们用一个真正会工作的最小 zip 模式:
 *   - 1 file entry with stored (no compression) payload
 *   - central directory
 *   - end of central directory record
 *
 * 由于 Node 没有内置 zip 写入,我们用 dynamic import 一个轻量依赖;
 * 但本仓库目前依赖里**没有** unzipper,所以走手动实现(下面这段 byte)。
 *
 * 简化:使用 node:zlib + 手工构造的中央目录。如果太复杂就 mock。
 *
 * 实际策略:本测试用动态 require('node:child_process') 调系统 zip 命令
 * 构造 zip 文件 — 这是最可靠的(unzipper 等库可能未装)。
 */

async function buildZip(filePath: string, contents: Map<string, string>): Promise<void> {
  // 用 system zip 命令构造一个标准 zip
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'log-unpack-zip-'));
  for (const [name, content] of contents) {
    const filePathInTmp = path.join(tmpDir, name);
    const dir = path.dirname(filePathInTmp);
    await mkdir(dir, { recursive: true });
    await writeFile(filePathInTmp, content, 'utf8');
  }
  // run: zip -r <filePath> .
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('zip', ['-r', filePath, '.'], { cwd: tmpDir });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`zip failed: ${stderr}`));
    });
    proc.on('error', reject);
  });
  await rm(tmpDir, { recursive: true, force: true });
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('unpackMany([]) 返空数组', async () => {
  const destDir = await mkdtemp(path.join(tmpdir(), 'log-unpack-dest-'));
  try {
    const results = await unpackMany([], destDir);
    assert.deepEqual(results, []);
  } finally {
    await rm(destDir, { recursive: true, force: true });
  }
});

test('3 个 zip 并行 → 3 个 unpacked-N 目录(N=1,2,3),无覆盖', async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'log-unpack-3-'));
  const destDir = await mkdtemp(path.join(tmpdir(), 'log-unpack-3-dest-'));
  try {
    const file1 = path.join(tmpDir, 'logs1.zip');
    const file2 = path.join(tmpDir, 'logs2.zip');
    const file3 = path.join(tmpDir, 'logs3.zip');
    await buildZip(file1, new Map([['a.log', 'aaa']]));
    await buildZip(file2, new Map([['b.log', 'bbb']]));
    await buildZip(file3, new Map([['c.log', 'ccc']]));

    const inputs: UploadedFile[] = [
      { originalname: 'logs1.zip', path: file1, size: 0 },
      { originalname: 'logs2.zip', path: file2, size: 0 },
      { originalname: 'logs3.zip', path: file3, size: 0 },
    ];

    const results = await unpackMany(inputs, destDir);

    assert.equal(results.length, 3);
    for (let i = 0; i < 3; i += 1) {
      const r = results[i]!;
      assert.equal(r.ok, true, `第 ${i + 1} 个应成功`);
      if (r.ok) {
        assert.ok(await exists(r.unpackedDir), `unpackedDir 存在: ${r.unpackedDir}`);
        assert.equal(path.basename(r.unpackedDir), `unpacked-${i + 1}`);
      }
    }

    // 3 个目录都不同名
    const dirs = results.filter((r) => r.ok).map((r) => (r as { unpackedDir: string }).unpackedDir);
    assert.equal(new Set(dirs).size, 3, '3 个目录名应唯一');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(destDir, { recursive: true, force: true });
  }
});

test('单 zip 1 文件 → unpacked-1 目录含解压文件', async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'log-unpack-single-'));
  const destDir = await mkdtemp(path.join(tmpdir(), 'log-unpack-single-dest-'));
  try {
    const file = path.join(tmpDir, 'logs.zip');
    await buildZip(file, new Map([['app.log', 'hello world']]));

    const results = await unpackMany([{ originalname: 'logs.zip', path: file, size: 0 }], destDir);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.ok, true);
    if (results[0]!.ok) {
      const { unpackedDir } = results[0]! as { unpackedDir: string };
      const extracted = path.join(unpackedDir, 'app.log');
      assert.ok(await exists(extracted), 'app.log 应被解压');
      const content = await (await import('node:fs/promises')).readFile(extracted, 'utf8');
      assert.equal(content, 'hello world');
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(destDir, { recursive: true, force: true });
  }
});

test('单包 size > 200MB 抛 PayloadTooLargeError', async () => {
  const destDir = await mkdtemp(path.join(tmpdir(), 'log-unpack-big-'));
  try {
    const inputs: UploadedFile[] = [
      { originalname: 'big.zip', path: '/tmp/whatever', size: 250 * 1024 * 1024 },
    ];
    await assert.rejects(
      () => unpackMany(inputs, destDir),
      (err: unknown) => err instanceof PayloadTooLargeError,
    );
  } finally {
    await rm(destDir, { recursive: true, force: true });
  }
});

test('第 3 个 zip 损坏 → unpacked-3 不存在 + 该项 ok:false + error 含 corrupted', async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'log-unpack-corrupt-'));
  const destDir = await mkdtemp(path.join(tmpdir(), 'log-unpack-corrupt-dest-'));
  try {
    const file1 = path.join(tmpDir, 'good.zip');
    const file2 = path.join(tmpDir, 'good2.zip');
    const file3 = path.join(tmpDir, 'corrupt.zip');
    await buildZip(file1, new Map([['a.log', 'aaa']]));
    await buildZip(file2, new Map([['b.log', 'bbb']]));
    // 写一个损坏的 zip(只是乱写字节)
    await writeFile(file3, Buffer.from('this is not a zip file at all', 'utf8'));

    const inputs: UploadedFile[] = [
      { originalname: 'good.zip', path: file1, size: 0 },
      { originalname: 'good2.zip', path: file2, size: 0 },
      { originalname: 'corrupt.zip', path: file3, size: 0 },
    ];

    const results = await unpackMany(inputs, destDir);

    assert.equal(results.length, 3);
    assert.equal(results[0]!.ok, true);
    assert.equal(results[1]!.ok, true);
    assert.equal(results[2]!.ok, false, '第 3 个损坏');
    if (!results[2]!.ok) {
      assert.match(results[2]!.error, /corrupt/i);
    }
    // unpacked-3 不存在
    assert.equal(await exists(path.join(destDir, 'unpacked-3')), false, '损坏 zip 的 unpacked-3 目录应被回滚');
    // unpacked-1, unpacked-2 存在
    assert.ok(await exists(path.join(destDir, 'unpacked-1')));
    assert.ok(await exists(path.join(destDir, 'unpacked-2')));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(destDir, { recursive: true, force: true });
  }
});

test('总数 > 20 抛 TooManyFilesError', async () => {
  const destDir = await mkdtemp(path.join(tmpdir(), 'log-unpack-many-'));
  try {
    const inputs: UploadedFile[] = Array.from({ length: 21 }, (_, i) => ({
      originalname: `f${i}.zip`,
      path: '/tmp/whatever',
      size: 0,
    }));
    await assert.rejects(
      () => unpackMany(inputs, destDir),
      (err: unknown) => err instanceof TooManyFilesError,
    );
  } finally {
    await rm(destDir, { recursive: true, force: true });
  }
});

test('PayloadTooLargeError 抛错前已存在的 unpacked-N 目录被回滚', async () => {
  // 通过 maxSingleSize: 0 强制整批失败
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'log-unpack-rollback-'));
  const destDir = await mkdtemp(path.join(tmpdir(), 'log-unpack-rollback-dest-'));
  try {
    const file = path.join(tmpDir, 'ok.zip');
    await buildZip(file, new Map([['x.log', 'x']]));

    await assert.rejects(
      () => unpackMany([{ originalname: 'ok.zip', path: file, size: 1 }], destDir, { maxSingleSize: 0 }),
      (err: unknown) => err instanceof PayloadTooLargeError,
    );
    // unpacked-1 目录应被回滚(空目录或不存在)
    assert.equal(await exists(path.join(destDir, 'unpacked-1')), false);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(destDir, { recursive: true, force: true });
  }
});