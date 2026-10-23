import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const output = await mkdtemp(path.join(tmpdir(), 'dialog-worker-tests-'));
let api;
try {
  await build({ entryPoints: ['src/api.ts'], outfile: path.join(output, 'api.mjs'), bundle: true, platform: 'node', format: 'esm' });
  api = await import(pathToFileURL(path.join(output, 'api.mjs')).href);
} finally { await rm(output, { recursive: true, force: true }); }
test('dispatch references are opaque, strict and never authorize forged identity metadata', () => {
  const reference = 'b45d7ced-94ed-47d9-bb26-5a0f7d1eec26';
  assert.equal(api.reference(JSON.stringify({ reference })), reference);
  for (const metadata of [undefined, '{}', '[]', 'null', JSON.stringify({ reference, tenantId: 1 }), JSON.stringify({ reference: '../other' })]) assert.throws(() => api.reference(metadata));
});
test('worker requires dedicated service configuration; URL credentials cannot become authority', () => {
  assert.throws(() => new api.DialogApi('short', 'http://localhost'));
  assert.throws(() => new api.DialogApi('a'.repeat(43), 'file:///etc/passwd'));
  const bad = new URL('http://localhost'); bad.username = 'unexpected';
  assert.throws(() => new api.DialogApi('a'.repeat(43), bad.href));
});
test('worker HTTP adapter rejects denied work and propagates cancellation without provider payload errors', async t => {
  let body = '';
  const server = createServer((req, res) => {
    req.on('data', data => { body += data; });
    if (req.url.endsWith('/denied')) res.writeHead(403).end('private provider payload');
    else if (req.url.endsWith('/wait')) { req.on('close', () => { res.destroy(); }); }
    else { res.setHeader('Content-Type', 'application/json'); res.end('{"allowed":true}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new api.DialogApi('a'.repeat(43), `http://127.0.0.1:${server.address().port}`);
  assert.deepEqual(await client.json('/allowed', { component: 'stt' }), { allowed: true });
  await assert.rejects(client.request('/denied', {}), error => !error.message.includes('private') && error instanceof api.DialogDenied && error.status === 403);
  const abort = new AbortController();
  const request = client.request('/wait', {}, 'opaque-claim', abort.signal); abort.abort();
  await assert.rejects(request, error => !(error instanceof api.DialogDenied));
  await assert.rejects(client.request('/wait', {}, 'opaque-claim', undefined, 50), error => !(error instanceof api.DialogDenied));
});
test('only a Dialog refusal or a lapsed lease ends the session; transient renewal failures retry', () => {
  const deadline = 15000;
  assert.equal(api.leaseLost(new api.DialogDenied(403), 1000, deadline), true);
  assert.equal(api.leaseLost(new api.DialogDenied(401), 1000, deadline), true);
  assert.equal(api.leaseLost(new api.DialogDenied(503), 1000, deadline), false);
  assert.equal(api.leaseLost(new DOMException('timeout', 'TimeoutError'), 1000, deadline), false);
  assert.equal(api.leaseLost(new TypeError('fetch failed'), 1000, deadline), false);
  assert.equal(api.leaseLost(new TypeError('fetch failed'), deadline, deadline), true);
  assert.equal(api.leaseLost(new api.DialogDenied(503), deadline + 1, deadline), true);
});
