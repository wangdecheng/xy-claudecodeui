/**
 * Tests for `handleMigrationCorruption` — the discriminated fail-closed wiring
 * point used by `server/index.js` to detect `MigrationCorruptionError` from
 * the database initializer and call `process.exit(1)` instead of silently
 * serving requests against a corrupted database.
 *
 * C-4 patch follow-up: this helper is the runtime safety guarantee that a
 * drift in the migration SHAs cannot lead to a running server.
 *
 * Test discipline:
 *   - 注入桩 exitFn 而不是真的调用 process.exit(避免杀掉测试运行器)
 *   - 覆盖 MigrationCorruptionError 触发 exit(1)
 *   - 覆盖普通 Error 不触发 exit,且 helper 自身抛错让 caller 继续走原始错误流
 *   - 覆盖 err 不是 Error 对象的边界情况(字符串/null/undefined)
 *   - 覆盖 discriminator 通过 `instanceof` 与 duck-typed 两条路径
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleMigrationCorruption,
  isMigrationCorruptionError,
} from '@/modules/database/init-helpers.js';
import { MigrationCorruptionError } from '@/modules/database/migrations.js';

/**
 * Test-only "process exited" sentinel — thrown by the stub `exitFn` so
 * `handleMigrationCorruption` can short-circuit cleanly without leaking
 * the (intentionally) non-halting stub return value into runtime code.
 */
class TestExitSignal extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`test-stub-exit(${code})`);
    this.name = 'TestExitSignal';
    this.code = code;
  }
}

/** Build a stub exit function that records calls AND throws to halt the test. */
function makeStubExit(): { fn: (code?: number) => never; calls: number[] } {
  const calls: number[] = [];
  const fn = ((code?: number): never => {
    calls.push(typeof code === 'number' ? code : 1);
    throw new TestExitSignal(calls[calls.length - 1]!);
  }) as (code?: number) => never;
  return { fn, calls };
}

test('isMigrationCorruptionError 识别真实 MigrationCorruptionError 实例', () => {
  const real = new MigrationCorruptionError('boom', ['m1'], [
    { name: 'm1', expectedSha: 'a', actualSha: 'b' },
  ]);
  assert.equal(isMigrationCorruptionError(real), true);
});

test('isMigrationCorruptionError 不识别普通 Error / 字符串 / null / undefined', () => {
  assert.equal(isMigrationCorruptionError(new Error('nope')), false);
  assert.equal(isMigrationCorruptionError('raw string'), false);
  assert.equal(isMigrationCorruptionError(null), false);
  assert.equal(isMigrationCorruptionError(undefined), false);
  // 缺 Error 原型链的"鸭子对象"不应被误判
  assert.equal(
    isMigrationCorruptionError({ name: 'MigrationCorruptionError' }),
    false,
  );
});

test('handleMigrationCorruption 收到 MigrationCorruptionError 时调用 exit(1)', () => {
  const { fn, calls } = makeStubExit();
  const real = new MigrationCorruptionError(
    'migrations drifted',
    ['m1'],
    [{ name: 'm1', expectedSha: 'a', actualSha: 'b' }],
  );
  // 命中 corruption 时 helper 必须调用 exitFn(1),并且控制流不会回到
  // 调用方 —— 通过 stub 抛 TestExitSignal 实现"halt"。
  assert.throws(
    () => handleMigrationCorruption(real, fn),
    (err: unknown) => err instanceof TestExitSignal && err.code === 1,
  );
  assert.deepEqual(calls, [1], 'corruption 分支应调用一次 exit(1)');
});

test('handleMigrationCorruption 收到普通 Error 时原样抛出,不调用 exit', () => {
  const { fn, calls } = makeStubExit();
  const original = new Error('disk full');
  assert.throws(
    () => handleMigrationCorruption(original, fn),
    (err: unknown) => err === original,
    'helper 应原样抛出原始 error',
  );
  assert.equal(calls.length, 0, '非 corruption 错误不应触发 exit');
});

test('handleMigrationCorruption 收到字符串/非 Error 时原样抛出', () => {
  const { fn, calls } = makeStubExit();
  assert.throws(
    () => handleMigrationCorruption('something bad', fn),
    (err: unknown) => err === 'something bad',
  );
  assert.throws(
    () => handleMigrationCorruption(undefined, fn),
    (err: unknown) => err === undefined,
  );
  assert.equal(calls.length, 0);
});

test('handleMigrationCorruption 兼容 duck-typed Error instance + name="MigrationCorruptionError"', () => {
  const { fn, calls } = makeStubExit();
  // 即便不是真正的 instanceof,也允许通过 `name` 字段判定 —— 用于跨
  // 模块边界 / 跨进程日志传递时的容错。
  const duck = Object.assign(new Error('from log line'), {
    name: 'MigrationCorruptionError',
  });
  assert.throws(
    () => handleMigrationCorruption(duck, fn),
    (err: unknown) => err instanceof TestExitSignal && err.code === 1,
  );
  assert.deepEqual(calls, [1]);
});
