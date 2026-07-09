/**
 * ConfigService hot-reload tests.
 *
 * Run:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json server/modules/onsite-analysis/tests/config.service.watch.test.ts
 *
 * Uses real chokidar (already installed) against a temp file. Each test gets
 * its own temp file + cleanup.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  _stopWatchingForTests,
  getConfig,
  loadConfig,
  onConfigChange,
  resetConfig,
  watchConfig,
} from '../config.service.js';

const FIXTURES_DIR = path.resolve(
  process.cwd(),
  'server/modules/onsite-analysis/tests/fixtures',
);
const GOOD_MIN = path.join(FIXTURES_DIR, 'good-minimal.json');

const WAIT_FOR_POLL_MS = 60;
const MAX_POLL_ATTEMPTS = 200;

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline && attempt < MAX_POLL_ATTEMPTS) {
    if (predicate()) {
      return;
    }
    attempt += 1;
    await new Promise((r) => setTimeout(r, WAIT_FOR_POLL_MS));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

test.beforeEach(() => {
  _stopWatchingForTests();
  resetConfig();
});

test('mtime change triggers callback and replaces singleton', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cfg-watch-'));
  const file = path.join(dir, 'cfg.json');
  await writeFile(file, JSON.stringify({ customers: [{ label: '其他问题', branch: null }], iterations: ['master_5.2_3.2'] }), 'utf8');

  await loadConfig(file);
  const off = watchConfig(file);
  t.after(() => {
    off();
  });

  let calls = 0;
  let lastLabel = '';
  const unsub = onConfigChange((cfg) => {
    calls += 1;
    lastLabel = cfg.data.customers[0].label;
  });
  t.after(unsub);

  // Mutate content — chokidar should pick this up via mtime
  await writeFile(
    file,
    JSON.stringify({
      customers: [
        { label: '其他问题', branch: null },
        { label: '山西公安', branch: 'master_5.2_3.2' },
      ],
      iterations: ['master_5.2_3.2'],
    }),
    'utf8',
  );

  await waitFor(() => calls >= 1);

  assert.ok(calls >= 1, 'callback should fire');
  const current = getConfig();
  assert.equal(current.data.customers[1].label, '山西公安', 'singleton should reflect new content');
  assert.equal(lastLabel, '其他问题');
});

test('unsubscribe stops further callbacks', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cfg-watch-unsub-'));
  const file = path.join(dir, 'cfg.json');
  await writeFile(file, JSON.stringify({ customers: [{ label: '其他问题', branch: null }], iterations: ['master_5.2_3.2'] }), 'utf8');
  await loadConfig(file);
  const off = watchConfig(file);
  t.after(off);

  let calls = 0;
  const unsub = onConfigChange(() => {
    calls += 1;
  });
  await waitFor(() => calls >= 1, 4000).catch(() => {}); // warm up
  const callsAfterWarmup = calls;
  unsub();

  // Mutate again; callback should NOT fire
  await writeFile(file, JSON.stringify({ customers: [{ label: '其他问题', branch: null }, { label: 'X', branch: 'master_x' }], iterations: ['master_5.2_3.2'] }), 'utf8');
  await new Promise((r) => setTimeout(r, 1000));

  assert.equal(calls, callsAfterWarmup, 'callback should not fire after unsubscribe');
});

test('multiple subscribers all receive callbacks', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cfg-watch-multi-'));
  const file = path.join(dir, 'cfg.json');
  await writeFile(file, JSON.stringify({ customers: [{ label: '其他问题', branch: null }], iterations: ['master_5.2_3.2'] }), 'utf8');
  await loadConfig(file);
  const off = watchConfig(file);
  t.after(off);

  let a = 0;
  let b = 0;
  let c = 0;
  const unsubA = onConfigChange(() => { a += 1; });
  const unsubB = onConfigChange(() => { b += 1; });
  const unsubC = onConfigChange(() => { c += 1; });
  t.after(() => { unsubA(); unsubB(); unsubC(); });

  await writeFile(file, JSON.stringify({ customers: [{ label: '其他问题', branch: null }], iterations: ['master_5.2_3.2', 'release_5.2_3.2_20260327'] }), 'utf8');

  await waitFor(() => a >= 1 && b >= 1 && c >= 1);

  assert.ok(a >= 1 && b >= 1 && c >= 1, 'all subscribers should fire');
});

test('invalid config on re-read is rejected, singleton stays at last known good', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cfg-watch-invalid-'));
  const file = path.join(dir, 'cfg.json');
  await writeFile(file, JSON.stringify({ customers: [{ label: '其他问题', branch: null }], iterations: ['master_5.2_3.2'] }), 'utf8');
  await loadConfig(file);
  const off = watchConfig(file);
  t.after(off);

  let invalidCalls = 0;
  const unsub = onConfigChange(
    () => {},
    () => {
      invalidCalls += 1;
    },
  );
  t.after(unsub);

  // Write a bad config (first item has branch set)
  await writeFile(file, JSON.stringify({ customers: [{ label: '其他问题', branch: 'master_5.2_3.2' }], iterations: ['master_5.2_3.2'] }), 'utf8');

  await waitFor(() => invalidCalls >= 1, 4000);

  const current = getConfig();
  assert.equal(current.data.customers.length, 1, 'should still hold previous good config');
  assert.equal(current.data.customers[0].branch, null);
});

test('watchConfig returns an unsubscribe function that stops the watcher', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cfg-watch-off-'));
  const file = path.join(dir, 'cfg.json');
  await writeFile(file, JSON.stringify({ customers: [{ label: '其他问题', branch: null }], iterations: ['master_5.2_3.2'] }), 'utf8');
  await loadConfig(file);

  const off = watchConfig(file);
  off(); // immediately stop watching

  let calls = 0;
  const unsub = onConfigChange(() => { calls += 1; });
  t.after(unsub);

  await writeFile(file, JSON.stringify({ customers: [{ label: '其他问题', branch: null }, { label: 'Y', branch: 'master_y' }], iterations: ['master_5.2_3.2'] }), 'utf8');
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(calls, 0, 'watcher should be stopped');
});