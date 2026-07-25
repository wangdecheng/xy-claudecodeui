import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initialOnsiteRunState,
  reduceOnsiteRunState,
} from './onsiteRunState';

test('onsite run state enables stop after an accepted send', () => {
  const state = reduceOnsiteRunState(initialOnsiteRunState, {
    type: 'send.accepted',
    startedAt: 1_234,
  });

  assert.equal(state.isProcessing, true);
  assert.equal(state.isStopping, false);
  assert.equal(state.startedAt, 1_234);
});

test('onsite run state shows stopping after abort request until terminal frame arrives', () => {
  const running = reduceOnsiteRunState(initialOnsiteRunState, {
    type: 'send.accepted',
    startedAt: 1_234,
  });
  const aborting = reduceOnsiteRunState(running, { type: 'abort.requested' });

  assert.equal(aborting.isProcessing, true);
  assert.equal(aborting.isStopping, true);
  assert.equal(aborting.startedAt, 1_234);
});

test('onsite run state disables stop after terminal frame', () => {
  const running = reduceOnsiteRunState(initialOnsiteRunState, {
    type: 'send.accepted',
    startedAt: 1_234,
  });
  const complete = reduceOnsiteRunState(running, { type: 'terminal' });

  assert.equal(complete.isProcessing, false);
  assert.equal(complete.isStopping, false);
  assert.equal(complete.startedAt, null);
});

test('onsite run state recovers when send is rejected by websocket layer', () => {
  const running = reduceOnsiteRunState(initialOnsiteRunState, {
    type: 'send.accepted',
    startedAt: 1_234,
  });
  const rejected = reduceOnsiteRunState(running, { type: 'send.rejected' });

  assert.equal(rejected.isProcessing, false);
  assert.equal(rejected.isStopping, false);
  assert.equal(rejected.startedAt, null);
});

test('onsite run state ignores abort while idle', () => {
  const state = reduceOnsiteRunState(initialOnsiteRunState, { type: 'abort.requested' });

  assert.equal(state, initialOnsiteRunState);
});
