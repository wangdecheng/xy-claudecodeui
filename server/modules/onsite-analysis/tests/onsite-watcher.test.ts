/**
 * OnsiteWatcher tests — TDD for the chokidar-based watcher.
 *
 * Covers:
 *  - 启动后监听 ONSITE_ROOT 目录变化
 *  - add 事件触发回调 (1s debounce)
 *  - unlink / change 事件触发回调
 *  - 多次快速变化合并为一次回调 (debounce)
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startOnsiteWatcher, onWatcherChange, stopOnsiteWatcher } from '../onsiteWatcher.js';

async function withIsolatedWatcher(runTest: (root: string) => Promise<void>): Promise<void> {
  const previousRoot = process.env.ONSITE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'onsite-watcher-'));
  const root = path.join(tempDir, 'onsite');

  process.env.ONSITE_ROOT = root;
  await mkdir(root, { recursive: true });

  startOnsiteWatcher();
  // Give chokidar a moment to attach the watcher before the test starts
  // writing files. Otherwise the very first write can be missed on slow CI.
  await new Promise((r) => setTimeout(r, 250));

  try {
    await runTest(root);
  } finally {
    stopOnsiteWatcher();
    if (previousRoot === undefined) {
      delete process.env.ONSITE_ROOT;
    } else {
      process.env.ONSITE_ROOT = previousRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Wait for `cb` to be called at least once within `timeoutMs`, OR until it
 * has been called `expected` times. Resolves with the number of calls
 * observed so the test can assert on debounce behavior.
 */
function waitForCalls(
  cb: () => number,
  expected: number = 1,
  timeoutMs: number = 5000,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const count = cb();
      if (count >= expected) {
        resolve(count);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timeout: expected ${expected} calls, got ${count}`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

test('启动后监听 ONSITE_ROOT, add 事件触发回调', async () => {
  await withIsolatedWatcher(async (root) => {
    let calls = 0;
    const off = onWatcherChange(() => {
      calls += 1;
    });

    try {
      await mkdir(path.join(root, '20260101-test'), { recursive: true });
      await writeFile(path.join(root, '20260101-test', 'problem.json'), '{}', 'utf8');

      await waitForCalls(() => calls, 1, 5000);
      assert.ok(calls >= 1);
    } finally {
      off();
    }
  });
});

test('unlink 事件触发回调', async () => {
  await withIsolatedWatcher(async (root) => {
    const dirPath = path.join(root, '20260202-rmtest');
    await mkdir(dirPath, { recursive: true });
    await writeFile(path.join(dirPath, 'problem.json'), '{}', 'utf8');

    // Wait for the initial add to settle
    await new Promise((r) => setTimeout(r, 1500));

    let calls = 0;
    const off = onWatcherChange(() => {
      calls += 1;
    });

    try {
      await rm(dirPath, { recursive: true, force: true });
      await waitForCalls(() => calls, 1, 5000);
      assert.ok(calls >= 1);
    } finally {
      off();
    }
  });
});

test('change 事件触发回调', async () => {
  await withIsolatedWatcher(async (root) => {
    const dirPath = path.join(root, '20260303-changetest');
    const jsonPath = path.join(dirPath, 'problem.json');
    await mkdir(dirPath, { recursive: true });
    await writeFile(jsonPath, '{"status":"pending_info"}', 'utf8');

    await new Promise((r) => setTimeout(r, 1500));

    let calls = 0;
    const off = onWatcherChange(() => {
      calls += 1;
    });

    try {
      await writeFile(jsonPath, '{"status":"analyzing"}', 'utf8');
      await waitForCalls(() => calls, 1, 5000);
      assert.ok(calls >= 1);
    } finally {
      off();
    }
  });
});

test('多次快速变化合并为一次回调 (1s debounce)', async () => {
  await withIsolatedWatcher(async (root) => {
    let calls = 0;
    const off = onWatcherChange(() => {
      calls += 1;
    });

    try {
      // Trigger 5 rapid changes inside a 200ms window
      for (let i = 0; i < 5; i += 1) {
        const dirPath = path.join(root, `20260404-burst-${i}`);
        await mkdir(dirPath, { recursive: true });
        await writeFile(path.join(dirPath, 'problem.json'), `{"i":${i}}`, 'utf8');
      }

      // Wait for the debounce window (1s) plus a margin
      await new Promise((r) => setTimeout(r, 1500));

      // Should have coalesced into roughly 1-2 calls, NOT 5
      assert.ok(
        calls >= 1 && calls <= 3,
        `Expected 1-3 coalesced calls, got ${calls}`,
      );
    } finally {
      off();
    }
  });
});