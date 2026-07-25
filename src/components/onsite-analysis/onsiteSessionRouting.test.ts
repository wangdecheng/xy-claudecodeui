import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isOnsiteFrameForSession,
  isStaleOnsiteIdleAck,
  readOnsiteSessionReady,
} from './onsiteSessionRouting';

test('resumed onsite hello resolves provider UUID before live frames arrive', () => {
  const ready = readOnsiteSessionReady({
    kind: 'onsite_session_ready',
    problemId: 'problem-1',
    sessionId: 'provider-uuid-1',
    activeSessionId: null,
  }, 'problem-1');

  assert.deepEqual(ready, {
    sessionId: 'provider-uuid-1',
    activeSessionId: null,
  });
  assert.equal(
    isOnsiteFrameForSession('provider-uuid-1', 'problem-1', ready!.sessionId, ready!.activeSessionId),
    true,
  );
});

test('first-run handoff accepts the original active run id and the migrated UUID', () => {
  assert.equal(
    isOnsiteFrameForSession('problem-1', 'problem-1', 'provider-uuid-1', 'problem-1'),
    true,
  );
  assert.equal(
    isOnsiteFrameForSession('provider-uuid-1', 'problem-1', 'provider-uuid-1', 'problem-1'),
    true,
  );
});

test('ready frame for a previously viewed problem is ignored', () => {
  const ready = readOnsiteSessionReady({
    kind: 'onsite_session_ready',
    problemId: 'problem-old',
    sessionId: 'provider-uuid-old',
  }, 'problem-current');

  assert.equal(ready, null);
  assert.equal(
    isOnsiteFrameForSession('unrelated', 'problem-current', 'provider-current', null),
    false,
  );
});

test('idle subscribe ack cannot clear a run started after that subscription', () => {
  assert.equal(isStaleOnsiteIdleAck(2_000, 1_000), true);
  assert.equal(isStaleOnsiteIdleAck(1_000, 2_000), false);
  assert.equal(isStaleOnsiteIdleAck(null, 2_000), false);
});
