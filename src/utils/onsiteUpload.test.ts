import assert from 'node:assert/strict';
import test from 'node:test';

import { requestOnsiteUpload } from './onsiteUpload';

class FakeXMLHttpRequest {
  static current: FakeXMLHttpRequest | null = null;

  readonly upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  readonly headers = new Map<string, string>();
  method = '';
  url = '';
  status = 0;
  responseText = '';
  sentBody: Document | XMLHttpRequestBodyInit | null = null;
  refreshedToken: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXMLHttpRequest.current = this;
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === 'x-refreshed-token' ? this.refreshedToken : null;
  }

  send(body: Document | XMLHttpRequestBodyInit | null): void {
    this.sentBody = body;
  }
}

const RealXMLHttpRequest = globalThis.XMLHttpRequest;

test.beforeEach(() => {
  FakeXMLHttpRequest.current = null;
  globalThis.XMLHttpRequest = FakeXMLHttpRequest as unknown as typeof XMLHttpRequest;
});

test.after(() => {
  globalThis.XMLHttpRequest = RealXMLHttpRequest;
});

function makeFile(name: string): File {
  const file = new Blob(['log-content'], { type: 'application/zip' }) as File;
  Object.defineProperty(file, 'name', { value: name });
  return file;
}

test('requestOnsiteUpload resolves 207 results and reports transfer progress', async () => {
  const progress: number[] = [];
  let refreshedToken = '';
  const pending = requestOnsiteUpload('problem/1', [makeFile('logs.zip')], {
    token: 'old-token',
    onProgress: (value) => progress.push(value),
    onRefreshedToken: (value) => {
      refreshedToken = value;
    },
  });

  const xhr = FakeXMLHttpRequest.current;
  assert.ok(xhr);
  assert.equal(xhr.method, 'POST');
  assert.equal(xhr.url, '/api/onsite/problems/problem%2F1/files');
  assert.equal(xhr.headers.get('Authorization'), 'Bearer old-token');
  assert.ok(xhr.sentBody instanceof FormData);

  xhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
  xhr.status = 207;
  xhr.responseText = JSON.stringify({
    results: [{ ok: true, originalName: 'logs.zip', unpackedDir: '/tmp/unpacked-1' }],
  });
  xhr.refreshedToken = 'new-token';
  xhr.onload?.();

  assert.deepEqual(await pending, [
    { ok: true, originalName: 'logs.zip', unpackedDir: '/tmp/unpacked-1' },
  ]);
  assert.deepEqual(progress, [50]);
  assert.equal(refreshedToken, 'new-token');
});

test('requestOnsiteUpload rejects with the server error message', async () => {
  const pending = requestOnsiteUpload('problem-2', [makeFile('too-large.zip')]);
  const xhr = FakeXMLHttpRequest.current;
  assert.ok(xhr);
  xhr.status = 413;
  xhr.responseText = JSON.stringify({ message: '单文件超过 200MB 上限' });
  xhr.onload?.();

  await assert.rejects(pending, /单文件超过 200MB 上限/);
});

test('requestOnsiteUpload rejects a success response without per-file results', async () => {
  const pending = requestOnsiteUpload('problem-2', [makeFile('logs.zip')]);
  const xhr = FakeXMLHttpRequest.current;
  assert.ok(xhr);
  xhr.status = 200;
  xhr.responseText = JSON.stringify({});
  xhr.onload?.();

  await assert.rejects(pending, /未返回文件处理结果/);
});

test('requestOnsiteUpload rejects network failures instead of silently returning an empty list', async () => {
  const pending = requestOnsiteUpload('problem-3', [makeFile('logs.zip')]);
  const xhr = FakeXMLHttpRequest.current;
  assert.ok(xhr);
  xhr.onerror?.();

  await assert.rejects(pending, /检查网络连接/);
});
