/**
 * onsite card-DSL system-prompt append (Tier2 跨层契约).
 *
 * Covers:
 *  - chat 路径(options 无 onsite)→ systemPrompt 无 append(零回归)
 *  - onsite 路径(options.onsite=true)→ systemPrompt.append === ONSITE_CARD_DSL
 *    且 append 教了 <card> 文法与 evidence/blocked 类型
 *
 * 运行:
 *   node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
 *     server/modules/onsite-analysis/tests/onsite-card-dsl-append.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { mapCliOptionsToSDK, ONSITE_CARD_DSL } from '@/claude-sdk.js';

test('chat 路径:无 options.onsite → systemPrompt 不含 append', () => {
  const sdk = mapCliOptionsToSDK({ cwd: '/tmp/x' });
  assert.equal(sdk.systemPrompt.type, 'preset');
  assert.equal(sdk.systemPrompt.preset, 'claude_code');
  assert.equal('append' in sdk.systemPrompt, false, 'chat 路径不应注入 append');
});

test('onsite 路径:options.onsite=true → systemPrompt.append === ONSITE_CARD_DSL', () => {
  const sdk = mapCliOptionsToSDK({ cwd: '/tmp/x', onsite: true });
  assert.equal(sdk.systemPrompt.preset, 'claude_code');
  assert.equal(sdk.systemPrompt.append, ONSITE_CARD_DSL);
});

test('ONSITE_CARD_DSL 教了 <card> 文法与关键卡片类型', () => {
  assert.match(ONSITE_CARD_DSL, /<card type="TYPE"/);
  for (const type of ['evidence', 'blocked', 'root_cause', 'sql']) {
    assert.match(ONSITE_CARD_DSL, new RegExp(`\`${type}\``), `应说明 ${type} 卡片`);
  }
  // 铁律:0 命中出 blocked、禁推测
  assert.match(ONSITE_CARD_DSL, /命中为 0/);
  assert.match(ONSITE_CARD_DSL, /禁止/);
});
