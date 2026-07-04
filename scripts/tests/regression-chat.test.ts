/**
 * regression-chat.sh 行为的契约测试。
 *
 * 运行方式(从仓库根目录执行):
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json scripts/tests/regression-chat.test.ts
 *
 * 设计原则:
 * - 用文件路径直接指到被测脚本(默认 ./scripts/regression-chat.sh)
 * - 每次子进程都在仓库根目录跑(因为脚本校验必须在仓库根执行)
 * - 只测 dry-run / --help / 未知 flag 这种纯逻辑路径;完整路径留给 CI
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'regression-chat.sh');

function runScript(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

test('preflight: scripts/regression-chat.sh 已存在', () => {
  // 哨兵:开发时若失败说明脚本还没创建
  assert.equal(existsSync(SCRIPT), true, `expected script at ${SCRIPT}`);
});

test('--dry-run 输出基线格式(5 个空格分隔字段)且 exit 0', () => {
  const result = runScript(['--dry-run']);
  assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  const trimmed = result.stdout.trim();
  const parts = trimmed.split(/\s+/);
  // 格式: <commit_sha> <ISO_date> <pass_count> <fail_count> <elapsed_ms>
  assert.equal(parts.length, 5, `expected 5 fields, got: ${trimmed}`);
  // commit SHA 是 40 字符 hex(允许 unknown 兜底)
  assert.match(parts[0], /^[0-9a-f]{40}$|unknown/, `commit_sha format: ${parts[0]}`);
  // ISO date 是 YYYY-MM-DDTHH:MM:SSZ 形态
  assert.match(parts[1], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, `ISO date format: ${parts[1]}`);
  // counts 与 elapsed 是非负整数
  assert.match(parts[2], /^\d+$/, `pass_count: ${parts[2]}`);
  assert.match(parts[3], /^\d+$/, `fail_count: ${parts[3]}`);
  assert.match(parts[4], /^\d+$/, `elapsed_ms: ${parts[4]}`);
});

test('--help / -h 输出用法且 exit 0', () => {
  for (const flag of ['--help', '-h']) {
    const result = runScript([flag]);
    assert.equal(result.status, 0, `${flag} should exit 0, stderr: ${result.stderr}`);
    assert.match(result.stdout, /Usage|--dry-run|--help/, `usage should be printed for ${flag}`);
  }
});

test('未知 flag → exit 非 0 且 stderr 说明', () => {
  const result = runScript(['--nonsense-flag-xyz']);
  assert.notEqual(result.status, 0);
  const out = result.stdout + result.stderr;
  assert.match(out, /unknown|invalid|Unknown|unknown flag|用法/, `should report unknown flag: ${out}`);
});

test('--dry-run 在 baseline 文件已存在时直接 cat 且不修改它', () => {
  // 准备:在仓库根放一个固定的 baseline,然后跑 --dry-run,验证内容不变
  const baselinePath = path.join(REPO_ROOT, 'chat-regression-baseline.txt');
  const bakPath = `${baselinePath}.bak`;
  const existed = existsSync(baselinePath);
  let existedContent: string | null = null;
  if (existed) {
    existedContent = readFileSync(baselinePath, 'utf8');
    renameSync(baselinePath, bakPath);
  }
  try {
    const FAKE = 'b'.repeat(40) + ' 2026-07-03T00:00:00Z 12 0 500';
    writeFileSync(baselinePath, FAKE);
    const result = runScript(['--dry-run']);
    assert.equal(result.status, 0);
    assert.equal(
      readFileSync(baselinePath, 'utf8'),
      FAKE,
      'dry-run must not modify existing baseline',
    );
    assert.match(result.stdout, /b{40}/, 'dry-run should print baseline content to stdout');
  } finally {
    if (existed && existedContent !== null) {
      writeFileSync(baselinePath, existedContent);
      renameSync(baselinePath, baselinePath); // no-op safety
    } else {
      // 清理 fake
      try {
        require('node:fs').unlinkSync(baselinePath);
      } catch {
        // ignore
      }
    }
    // 还原 bak
    if (existed && existedContent !== null && existsSync(bakPath)) {
      renameSync(bakPath, baselinePath);
    }
  }
});

// ---------------------------------------------------------------------------
// I-1 fix: parse the LAST occurrence of each metric, not the SUM
// ---------------------------------------------------------------------------
//
// node --test TAP outputs BOTH a per-file summary AND a global summary.
// Both look like `ℹ pass N` / `ℹ fail N` / `ℹ tests N`. The previous awk
// implementation summed across all lines, which double-counts when more
// than one test file is run. This test verifies the parsing logic in the
// actual regression-chat.sh script against a controlled TMP_OUT input.

test('regression-chat.sh 解析多文件 TAP 输出:取最后一行而非求和', () => {
  // 构造一个 fixture:多文件 + 全局汇总,故意让 last value 与 SUM 不同
  // 三个 pass lines: 5, 3, 11(sums to 19, last is 11)
  // 三个 fail lines: 0, 0, 2(sums to 2 — coincide here)
  // 三个 tests lines: 5, 3, 13(sums to 21, last is 13)
  // Use the last row only — global total is pass=11 fail=2 tests=13.
  // sum-bug would produce pass=19 fail=2 tests=21.
  const TMP_OUT = path.join(REPO_ROOT, 'scripts', 'tests', 'fixture-tap-output.txt');
  const content = [
    'TAP version 13',
    'ok 1 - first test',
    'ℹ tests 5',
    'ℹ pass 5',
    'ℹ fail 0',
    'ok 2 - second suite header',
    'ℹ tests 3',
    'ℹ pass 3',
    'ℹ fail 0',
    'ℹ tests 13',
    'ℹ pass 11',
    'ℹ fail 2',
  ].join('\n');
  writeFileSync(TMP_OUT, content);

  try {
    // 用脚本本身使用的解析逻辑(grep + awk),证明 last-value vs sum 的差异
    const probeResult = spawnSync(
      'bash',
      [
        '-c',
        [
          // Script's NEW parsing (last-value)
          `NEW_PASS=$(grep -E '^ℹ +pass' "${TMP_OUT}" | tail -n1 | awk '{ gsub(/[^0-9]/, "", $NF); print $NF+0 }')`,
          `NEW_TESTS=$(grep -E '^ℹ +tests' "${TMP_OUT}" | tail -n1 | awk '{ gsub(/[^0-9]/, "", $NF); print $NF+0 }')`,
          `NEW_FAIL=$(grep -E '^ℹ +fail' "${TMP_OUT}" | tail -n1 | awk '{ gsub(/[^0-9]/, "", $NF); print $NF+0 }')`,
          `echo "NEW:PASS=$NEW_PASS FAIL=$NEW_FAIL TESTS=$NEW_TESTS"`,
          // Script's OLD parsing (sum) for comparison
          `OLD_PASS=$(grep -E '^ℹ +(tests|pass)' "${TMP_OUT}" | awk '/pass/ { gsub(/[^0-9]/, "", $NF); sum += $NF } END { print sum+0 }')`,
          `OLD_TESTS=$(grep -E '^ℹ +tests' "${TMP_OUT}" | awk '{ gsub(/[^0-9]/, "", $NF); sum += $NF } END { print sum+0 }')`,
          `OLD_FAIL=$(grep -E '^ℹ +fail' "${TMP_OUT}" | awk '{ gsub(/[^0-9]/, "", $NF); sum += $NF } END { print sum+0 }')`,
          `echo "OLD:PASS=$OLD_PASS FAIL=$OLD_FAIL TESTS=$OLD_TESTS"`,
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(
      probeResult.status,
      0,
      `probe failed: ${probeResult.stderr} ${probeResult.stdout}`,
    );
    const out = probeResult.stdout;
    // Confirm fixture separates the two: OLD sum != NEW last
    assert.match(out, /OLD:PASS=19/, 'sum-bug should yield 19 (5+3+11)');
    // Pass / fail / tests appear on the same line as `OLD:` because we used
    // a single echo line — assert presence of both the values themselves.
    assert.match(out, /\bTESTS=21\b/, 'sum-bug should yield 21 (5+3+13)');
    assert.match(out, /\bPASS=11\b/, 'last-value should yield 11');
    assert.match(out, /\bTESTS=13\b/, 'last-value should yield 13');

    // Now verify the *actual script* uses the last-value approach: re-extract
    // the parsing lines from regression-chat.sh and assert they all use
    // tail -n1 (not just `awk '{ sum += ... } END { print sum }`).
    const scriptText = readFileSync(SCRIPT, 'utf8');
    // Negative assertion: no remaining `sum += $NF ... END { print sum+0 }`
    // style parsing for ANY of the three metrics (pass / fail / tests).
    const sumOnlyLines = scriptText.match(/_COUNT="\$\(grep[^\n]*awk[^\n]*\{[^\n]*sum \+=[^)]*\)/g) ?? [];
    assert.equal(
      sumOnlyLines.length,
      0,
      `regression-chat.sh still uses sum-of-awk parsing: ${sumOnlyLines.join('\n')}`,
    );
    // Positive assertion: each *_COUNT line uses `tail -n1 | awk ...` for last-value
    // We expect exactly 3 occurrences (PASS / FAIL / TESTS).
    const tailLines = scriptText
      .split('\n')
      .filter((line) => line.includes('_COUNT="$(grep'))
      .filter((line) => line.includes('| tail -n1 | awk'));
    assert.equal(
      tailLines.length,
      3,
      `regression-chat.sh should use tail -n1 last-value parsing for ALL three metrics. got ${tailLines.length} of 3.\n` +
        `tail-n1 lines:\n${tailLines.join('\n')}`,
    );
  } finally {
    try {
      require('node:fs').unlinkSync(TMP_OUT);
    } catch {
      // ignore
    }
  }
});
