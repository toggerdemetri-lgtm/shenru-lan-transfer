import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createApp } from '../server.mjs';

async function options(t) {
  const dir = await mkdtemp(join(tmpdir(), 'shenru-discovery-'));
  const resources = [];
  t.after(async () => { for (const r of resources.toReversed()) await r.close(); await rm(dir, { recursive: true, force: true }); });
  return { dataDir: join(dir, 'first'), root: dir, resources, port: 0, discoveryPort: 43000 + Math.floor(Math.random() * 10000), electionMs: 900, probeLocal: false, reserveBytes: 0 };
}

test('first launcher hosts and later launcher joins through real UDP and HTTP', async t => {
  const { startPortable } = await import('../portable.mjs');
  const opts = await options(t);
  const first = await startPortable(opts); opts.resources.push(first);
  assert.equal(first.mode, 'host');
  const second = await startPortable({ ...opts, dataDir: join(opts.root, 'second') });
  opts.resources.push(second);
  assert.equal(second.mode, 'join');
  assert.equal(second.bootId, first.bootId);
  assert.equal((await fetch(second.url + 'api/service-info')).status, 200);
});

test('near simultaneous launchers converge to one service', async t => {
  const { startPortable } = await import('../portable.mjs');
  const opts = await options(t);
  const results = await Promise.all([startPortable({ ...opts, id: 'a' }), startPortable({ ...opts, dataDir: join(opts.root, 'second'), id: 'b' })]);
  opts.resources.push(...results);
  assert.equal(results.filter(x => x.mode === 'host').length, 1);
  assert.equal(results[0].bootId, results[1].bootId);
});

test('unrelated occupied HTTP port is not mistaken for a host; use a free port', async t => {
  const { startPortable } = await import('../portable.mjs');
  const other = createServer((req, res) => { res.end('{"app":"other"}'); });
  await new Promise(r => other.listen(0, '0.0.0.0', r));
  t.after(() => new Promise(r => other.close(r)));
  const opts = await options(t);
  const result = await startPortable({ ...opts, port: other.address().port, probeLocal: true });
  opts.resources.push(result);
  assert.equal(result.mode, 'host');
  assert.notEqual(Number(new URL(result.url).port), other.address().port);
});

test('automatic discovery never joins an older service without content encryption',async t=>{
 const {verifyService}=await import('../lib/discovery.mjs');
 const legacy=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({app:'shenru-lan',protocol:1,bootId:'old-plaintext',startedAt:1}));});
 await new Promise(r=>legacy.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>legacy.close(r)));
 assert.equal(await verifyService('127.0.0.1',legacy.address().port),null);
});

test('unavailable discovery still permits hosting and reports manual connection warning', async t => {
  const { startPortable } = await import('../portable.mjs');
  const opts = await options(t);
  const result = await startPortable({ ...opts, discoveryFactory: async () => { throw Error('UDP EACCES'); } });
  opts.resources.push(result);
  assert.equal(result.mode, 'host');
  assert.match(result.warning, /自动发现/);
  assert.equal((await fetch(result.url + 'api/service-info')).status, 200);
});

test('loopback-only legacy service is never replaced with an unverified LAN URL', async t => {
  const { startPortable } = await import('../portable.mjs');
  const opts = await options(t);
  const legacy = await createApp({ port: 0, host: '127.0.0.1', dataDir: join(opts.root, 'legacy') });
  await legacy.start(); opts.resources.push(legacy);
  const result = await startPortable({ ...opts, port: legacy.server.address().port, probeLocal: true }); opts.resources.push(result);
  assert.equal(result.url, `http://127.0.0.1:${legacy.server.address().port}/`);
  assert.match(result.warning, /仅允许本机/);
});
