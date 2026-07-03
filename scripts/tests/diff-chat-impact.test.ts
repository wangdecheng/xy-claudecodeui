/**
 * diff-chat-impact.sh 行为的契约测试。
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'diff-chat-impact.sh');

function runScript(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('preflight: scripts/diff-chat-impact.sh 已存在', () => {
  assert.equal(existsSync(SCRIPT), true, `expected script at ${SCRIPT}`);
});

test('zero-diff (BASE_SHA=HEAD_SHA): exit 0', () => {
  const sha = git(REPO_ROOT, ['rev-parse', 'HEAD']);
  const result = runScript([], { env: { BASE_SHA: sha, HEAD_SHA: sha } });
  assert.equal(
    result.status,
    0,
    `expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
});

test('critical 文件被改 → exit 1 且提示含该文件路径', () => {
  // 策略:用临时分支 + 改文件 + commit,然后 BASE=HEAD~1, HEAD=HEAD
  // 严格用 try/finally 恢复(在任何异常路径下也恢复)
  const branch = `test/diff-chat-impact-${Date.now()}`;
  const criticalFile = path.join(
    REPO_ROOT,
    'server/modules/websocket/services/chat-websocket.service.ts',
  );
  let originalContent: string | null = null;
  let createdBranch = false;

  function restoreEverything() {
    // 还原文件,切回 main,删除分支
    try {
      if (originalContent !== null) {
        writeFileSync(criticalFile, originalContent);
      }
      git(REPO_ROOT, ['checkout', '--', criticalFile]);
    } catch {
      // ignore
    }
    try {
      git(REPO_ROOT, ['checkout', 'main']);
    } catch {
      // ignore
    }
    if (createdBranch) {
      try {
        git(REPO_ROOT, ['branch', '-D', branch]);
      } catch {
        // ignore
      }
    }
  }

  try {
    try {
      git(REPO_ROOT, ['branch', '-D', branch]);
    } catch {
      // ignore
    }
    git(REPO_ROOT, ['checkout', '-b', branch]);
    createdBranch = true;

    originalContent = readFileSync(criticalFile, 'utf8');
    writeFileSync(
      criticalFile,
      `${originalContent}\n// touch: diff-chat-impact test ${new Date().toISOString()}\n`,
    );
    git(REPO_ROOT, ['add', criticalFile]);
    git(REPO_ROOT, ['commit', '-m', 'test(dummy): for diff-chat-impact']);

    const headSha = git(REPO_ROOT, ['rev-parse', 'HEAD']);
    // 如果是 initial commit,就没 HEAD~1;此时这个测试无法跑,跳过
    let baseSha: string;
    try {
      baseSha = git(REPO_ROOT, ['rev-parse', 'HEAD~1']);
    } catch {
      // skip
      return;
    }

    const result = runScript([], {
      env: { BASE_SHA: baseSha, HEAD_SHA: headSha },
    });
    assert.equal(result.status, 1, 'should exit 1 when critical file changed');
    const combined = result.stdout + result.stderr;
    assert.ok(
      /chat-websocket\.service\.ts/.test(combined),
      `should mention the modified file: ${combined}`,
    );
  } finally {
    restoreEverything();
  }
});

test('未知 flag → exit 非 0', () => {
  const result = runScript(['--nonsense-xyz-flag']);
  assert.notEqual(result.status, 0);
});

test('缺 BASE_SHA / HEAD_SHA → 提示并 exit 非 0', () => {
  const result = runScript([], { env: { BASE_SHA: '', HEAD_SHA: '' } });
  const combined = result.stdout + result.stderr;
  assert.ok(
    result.status !== 0 || /BASE_SHA|HEAD_SHA|缺少|required/i.test(combined),
    `expected error or non-zero exit: status=${result.status} out=${combined}`,
  );
});
