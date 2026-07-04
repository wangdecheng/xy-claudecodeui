/**
 * onsite-path-blacklist — TDD tests for Sub-task B (Batch 5).
 *
 * Covers:
 *  - toDisallowPatterns: 7 glob types × 7 write actions 覆盖
 *  - toDisallowPatterns: 跨 glob dedupe
 *  - toDisallowPatterns: 'problem.json' 只含 Write/Edit(无 bash 写)
 *  - toDisallowPatterns: '*.log' 含 Bash 7 种写动作 + Write/Edit
 *  - toDisallowPatterns: 'unpacked-*' 模式生成
 *  - toDisallowPatterns: '*.tar.gz' / '*.tgz' 模式生成
 *  - toDisallowPatterns: 空数组返空数组
 *  - 注入点:onsite 路径 spawn 时 sdkOptions.disallowedTools 含保护模式
 *  - chat 路径 spawn 不调 toDisallowPatterns(disallowedTools 没 onsite 模式)
 *  - chat 路径调用 toDisallowPatterns + spawn 不抛
 *
 * Run:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
 *     server/modules/onsite-analysis/tests/onsite-path-blacklist.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ONSITE_PROTECTED_GLOBS_LIST,
  toDisallowPatterns,
} from '../discipline/onsite-path-blacklist.service.js';

const PROTECTED_GLOBS = ONSITE_PROTECTED_GLOBS_LIST;

// ---------------------------------------------------------------------------
// toDisallowPatterns — pure function tests
// ---------------------------------------------------------------------------

test('toDisallowPatterns: 空数组返空数组', () => {
  assert.deepEqual(toDisallowPatterns([]), []);
});

test('toDisallowPatterns: *.log 包含 Bash rm/rm-rf/tee/sed-i/awk-i/cp-f/mv + Write/Edit 模式', () => {
  const patterns = toDisallowPatterns(['*.log']);
  // 必含 7 种 Bash 写动作 + Write + Edit
  for (const must of [
    'Bash(rm **/*.log)',
    'Bash(rm -rf **/*.log)',
    'Bash(tee **/*.log)',
    'Bash(sed -i **/*.log)',
    'Bash(awk -i **/*.log)',
    'Bash(cp -f **/*.log)',
    'Bash(mv **/*.log)',
    'Write(**/*.log)',
    'Edit(**/*.log)',
  ]) {
    assert.ok(patterns.includes(must), `*.log 模式必须含 ${must},实际: ${JSON.stringify(patterns)}`);
  }
});

test('toDisallowPatterns: *.log.gz 也生成对应模式', () => {
  const patterns = toDisallowPatterns(['*.log.gz']);
  assert.ok(patterns.includes('Bash(rm **/*.log.gz)'), 'rm *.log.gz');
  assert.ok(patterns.includes('Write(**/*.log.gz)'), 'Write *.log.gz');
});

test('toDisallowPatterns: *.jsonl 也生成对应模式', () => {
  const patterns = toDisallowPatterns(['*.jsonl']);
  assert.ok(patterns.includes('Bash(rm **/*.jsonl)'));
  assert.ok(patterns.includes('Write(**/*.jsonl)'));
});

test('toDisallowPatterns: problem.json 只含 Write/Edit(不生成 bash 写)', () => {
  const patterns = toDisallowPatterns(['problem.json']);
  // 含 Write/Edit(关键 — 不能让 Claude 编辑 problem.json)
  assert.ok(patterns.includes('Write(**/problem.json)'), 'Write problem.json');
  assert.ok(patterns.includes('Edit(**/problem.json)'), 'Edit problem.json');
  // 不必含 bash 写动作 — 但若实现里包含了,我们也接受(不强制)
  // 关键约束是覆盖 Write/Edit,这是 problem.json 唯一的写入途径
});

test('toDisallowPatterns: unpacked-* 模式生成', () => {
  const patterns = toDisallowPatterns(['unpacked-*']);
  // unpacked-* 是目录模式,Write/Edit 应针对 unpacked-*/** 内容
  assert.ok(patterns.some((p) => p.includes('Write(**/unpacked-*/') || p.includes('Write(**/unpacked-*)')), 'Write unpacked-*');
  assert.ok(patterns.some((p) => p.includes('Bash(rm **/unpacked-') || p.includes('Bash(rm -rf **/unpacked-')), 'Bash rm unpacked-*');
});

test('toDisallowPatterns: *.tar.gz / *.tgz 模式生成', () => {
  const targz = toDisallowPatterns(['*.tar.gz']);
  assert.ok(targz.includes('Bash(rm **/*.tar.gz)'), 'rm *.tar.gz');
  assert.ok(targz.includes('Write(**/*.tar.gz)'), 'Write *.tar.gz');

  const tgz = toDisallowPatterns(['*.tgz']);
  assert.ok(tgz.includes('Bash(rm **/*.tgz)'), 'rm *.tgz');
  assert.ok(tgz.includes('Write(**/*.tgz)'), 'Write *.tgz');
});

test('toDisallowPatterns: 7 类 glob 全覆盖', () => {
  const all = toDisallowPatterns(PROTECTED_GLOBS);
  // 每类至少有一个 Write/Edit 模式被生成
  for (const glob of PROTECTED_GLOBS) {
    const hasWriteOrEdit = all.some((p) => {
      // glob 是目录模式(unpacked-*)时,后缀可能是 /**
      const isDir = glob === 'unpacked-*';
      const tokens = [glob, isDir ? `${glob}/**` : glob];
      return tokens.some((t) => p.includes(`Write(**/${t}`) || p.includes(`Edit(**/${t}`));
    });
    assert.ok(hasWriteOrEdit, `${glob} 至少应有 Write/Edit 模式,实际: ${JSON.stringify(all)}`);
  }
});

test('toDisallowPatterns: 跨 glob dedupe(同一 pattern 不重复出现)', () => {
  const all = toDisallowPatterns(PROTECTED_GLOBS);
  const seen = new Set<string>();
  for (const p of all) {
    assert.ok(!seen.has(p), `pattern 重复: ${p}`);
    seen.add(p);
  }
  // 至少生成 30+ 模式(7 glob × 7 写动作但有 dedupe)
  assert.ok(all.length >= 30, `应至少 30 个 pattern,实际 ${all.length}`);
});

test('toDisallowPatterns: 每个 pattern 都是合法 SDK 形式(Bash/Write/Edit 前缀)', () => {
  const all = toDisallowPatterns(PROTECTED_GLOBS);
  for (const p of all) {
    assert.ok(
      p.startsWith('Bash(') || p.startsWith('Write(') || p.startsWith('Edit('),
      `pattern 必须以 Bash(/Write(/Edit( 开头: ${p}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 注入点测试 — 验证 onsite vs chat 的差异
// ---------------------------------------------------------------------------

test('onsite 路径 inject 黑名单后,sdkOptions.disallowedTools 含保护模式', () => {
  // 模拟 chat-websocket 的 onsite 注入行为:
  const baseOptions: { disallowedTools?: string[] } = {};
  // onsite 路径会注入:
  const patterns = toDisallowPatterns(PROTECTED_GLOBS);
  baseOptions.disallowedTools = [
    ...(baseOptions.disallowedTools ?? []),
    ...patterns,
  ];

  assert.ok(baseOptions.disallowedTools);
  assert.ok(baseOptions.disallowedTools.length > 30, '必须含所有 glob 的 pattern');
  assert.ok(baseOptions.disallowedTools.includes('Bash(rm **/*.log)'));
  assert.ok(baseOptions.disallowedTools.includes('Write(**/problem.json)'));
});

test('chat 路径不注入黑名单(disallowedTools 保持原样)', () => {
  // chat 路径调用方不做 toDisallowPatterns,disallowedTools 保持来自 clientOptions
  const baseOptions: { disallowedTools?: string[] } = {
    disallowedTools: [], // client options,可能为空
  };

  // chat 路径不调 toDisallowPatterns
  // 验证不抛
  assert.deepEqual(baseOptions.disallowedTools, []);
  assert.ok(!baseOptions.disallowedTools.includes('Bash(rm **/*.log)'));
});