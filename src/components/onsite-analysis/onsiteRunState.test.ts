import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initialOnsiteRunState,
  reduceOnsiteRunState,
} from './onsiteRunState';

test('onsite run state enables stop after an accepted send', () => {
  const state = reduceOnsiteRunState(initialOnsiteRunState, { type: 'send.accepted' });

  assert.equal(state.isProcessing, true);
});

test('onsite run state stays processing after abort request until terminal frame arrives', () => {
  const running = reduceOnsiteRunState(initialOnsiteRunState, { type: 'send.accepted' });
  const aborting = reduceOnsiteRunState(running, { type: 'abort.requested' });

  assert.equal(aborting.isProcessing, true);
});

test('onsite run state disables stop after terminal frame', () => {
  const running = reduceOnsiteRunState(initialOnsiteRunState, { type: 'send.accepted' });
  const complete = reduceOnsiteRunState(running, { type: 'terminal' });

  assert.equal(complete.isProcessing, false);
});

test('onsite run state recovers when send is rejected by websocket layer', () => {
  const running = reduceOnsiteRunState(initialOnsiteRunState, { type: 'send.accepted' });
  const rejected = reduceOnsiteRunState(running, { type: 'send.rejected' });

  assert.equal(rejected.isProcessing, false);
});
