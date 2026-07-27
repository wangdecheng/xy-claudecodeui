import assert from 'node:assert/strict';
import test from 'node:test';

import { requestOnsiteDownload } from './onsiteDownload';

test('onsite download request carries the logged-in token', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  let receivedInit: RequestInit | undefined;

  globalThis.localStorage = {
    getItem: () => 'test-token',
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  } as Storage;
  globalThis.fetch = async (_input, init) => {
    receivedInit = init;
    return new Response('download', { status: 200 });
  };

  try {
    const response = await requestOnsiteDownload('problem/1', '/tmp/report.zip');

    assert.equal(response.status, 200);
    assert.equal(new Headers(receivedInit?.headers).get('Authorization'), 'Bearer test-token');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalStorage;
  }
});
