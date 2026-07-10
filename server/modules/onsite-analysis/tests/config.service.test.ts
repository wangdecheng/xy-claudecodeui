/**
 * ConfigService tests — TDD discipline: write failing tests first.
 *
 * Run:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json server/modules/onsite-analysis/tests/config.service.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ConfigFileNotFoundError,
  InvalidConfigError,
  getConfig,
  loadConfig,
  resetConfig,
  resolveConfigPath,
} from '../config.service.js';

const FIXTURES_DIR = path.resolve(
  process.cwd(),
  'server/modules/onsite-analysis/tests/fixtures',
);
const REPO_ROOT = path.resolve(process.cwd());
const GOOD_CONFIG = path.join(REPO_ROOT, 'config/customer-analysis.json');
const BAD_FIRST = path.join(FIXTURES_DIR, 'bad-first-not-null.json');
const GOOD_MIN = path.join(FIXTURES_DIR, 'good-minimal.json');

test.beforeEach(() => {
  resetConfig();
});

test('loadConfig parses 17 customers + 2 iterations from real config', async () => {
  const cfg = await loadConfig(GOOD_CONFIG);

  assert.equal(cfg.status, 'OK');
  assert.equal(cfg.data.customers.length, 17);
  assert.equal(cfg.data.iterations.length, 6);
  assert.equal(cfg.data.customers[0].label, '其他问题');
  assert.equal(cfg.data.customers[0].branch, null);
  assert.equal(typeof cfg.mtime, 'string');
  assert.ok(cfg.mtime.length > 0);
});

test('loadConfig rejects bad-first-not-null fixture with InvalidConfigError', async () => {
  await assert.rejects(
    loadConfig(BAD_FIRST),
    (error: unknown) => {
      assert.ok(error instanceof InvalidConfigError, `expected InvalidConfigError, got ${error}`);
      const message = (error as Error).message;
      assert.match(message, /branch/);
      return true;
    },
  );
});

test('loadConfig throws ConfigFileNotFoundError when file missing', async () => {
  const missing = path.join(FIXTURES_DIR, 'does-not-exist.json');
  await assert.rejects(
    loadConfig(missing),
    (error: unknown) => {
      assert.ok(error instanceof ConfigFileNotFoundError);
      return true;
    },
  );
});

test('getConfig throws before loadConfig', () => {
  assert.throws(
    () => getConfig(),
    (error: unknown) => {
      assert.match((error as Error).message, /not loaded/i);
      return true;
    },
  );
});

test('getConfig returns singleton after loadConfig', async () => {
  const a = await loadConfig(GOOD_CONFIG);
  const b = getConfig();
  assert.equal(b, a, 'getConfig must return the same instance that loadConfig returned');
  assert.equal(b.status, 'OK');
});

test('getConfig still returns the singleton even after re-loading a different config', async () => {
  const first = await loadConfig(GOOD_CONFIG);
  const second = await loadConfig(GOOD_MIN);
  const current = getConfig();
  assert.equal(current, second, 'singleton is replaced by the latest loadConfig');
  assert.notEqual(current, first);
  assert.equal(current.data.customers.length, 1);
});

test('loadConfig with relative path resolves from process.cwd()', async () => {
  // Use a temp dir with a fixture written by us
  const dir = await mkdtemp(path.join(tmpdir(), 'cfg-rel-'));
  try {
    const file = path.join(dir, 'cfg.json');
    await writeFile(file, JSON.stringify({ customers: [{ label: '其他问题', branch: null }], iterations: ['master_5.2_3.2'] }), 'utf8');
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      const cfg = await loadConfig('cfg.json');
      assert.equal(cfg.status, 'OK');
    } finally {
      process.chdir(previousCwd);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// I-3 fix: resolveConfigPath should normalize `.` / `..` segments so that
// downstream callers (mtime cache, watchConfig path comparison) get a
// canonical representation regardless of input form.
// ---------------------------------------------------------------------------

test('resolveConfigPath 相对路径含 ./ 被 normalize', () => {
  const previousCwd = process.cwd();
  // Use a directory we can both chdir to AND reliably compute. On macOS
  // /tmp is a symlink to /private/tmp, so chdir to a known canonical place
  // and use process.cwd() (post-chdir) to compute the expected result —
  // that's exactly what the implementation does too.
  const dir = path.dirname(previousCwd);
  process.chdir(dir);
  try {
    const cwdNow = process.cwd();
    const result = resolveConfigPath('./foo/bar.json');
    // Expected: path.resolve(cwd, './foo/bar.json') = cwd + '/foo/bar.json'
    const expected = path.resolve(cwdNow, 'foo/bar.json');
    assert.equal(result, expected, `expected normalized path, got ${result}`);
    assert.ok(!result.includes('/./'), `result must not contain /./ segment, got ${result}`);
  } finally {
    process.chdir(previousCwd);
  }
});

test('resolveConfigPath 相对路径含 ../ 被 normalize', () => {
  const previousCwd = process.cwd();
  const dir = path.dirname(previousCwd);
  process.chdir(dir);
  try {
    const cwdNow = process.cwd();
    const result = resolveConfigPath('./foo/../bar.json');
    // `foo/..` should collapse, leaving `bar.json` resolved under cwd.
    const expected = path.resolve(cwdNow, 'bar.json');
    assert.equal(result, expected, `expected normalized path, got ${result}`);
    assert.ok(!result.includes('..'), `result must not contain '..', got ${result}`);
  } finally {
    process.chdir(previousCwd);
  }
});

test('resolveConfigPath 绝对路径含 ./ 也被 normalize', () => {
  // For absolute input we control the input directly so we can compute expected.
  const dir = path.resolve('/foo/bar');
  const input = `${dir}/./baz/../cfg.json`;
  const result = resolveConfigPath(input);
  const expected = path.normalize(`${dir}/cfg.json`);
  assert.equal(result, expected, `expected normalized absolute path, got ${result}`);
  assert.ok(!result.includes('/.'), `result must not contain '/.', got ${result}`);
  assert.ok(!result.includes('..'), `result must not contain '..', got ${result}`);
});