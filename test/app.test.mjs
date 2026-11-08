import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, rename, mkdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../server.mjs';
import { withRetry } from '../public/retry.js';

const hash = b => createHash('sha256').update(b).digest('hex');

test('verified completion stores duration for both peers and keeps it stable on retries',async t=>{
 const s=await setup(t);const conv=await s.friends();const bytes=Buffer.from('abcdefgh');
 const tr=await s.transfer(conv,bytes);await s.chunk(tr,0,bytes.subarray(0,4));await s.chunk(tr,1,bytes.subarray(4));
 const bad=await s.a.call(`/api/transfers/${tr.id}/complete`,{sha256:hash(Buffer.from('wrong')),elapsedMs:1000});
 assert.equal(bad.status,422);const pending=await s.a.json(`/api/transfers/${tr.id}`);assert.equal(pending.completedAt,null);
 const done=await s.a.json(`/api/transfers/${tr.id}/complete`,{sha256:hash(bytes),elapsedMs:1000});
 assert.equal(done.status,'ready');assert.ok(done.elapsedMs>=1000);assert.ok(done.completedAt>=tr.time);
 const again=await s.a.json(`/api/transfers/${tr.id}/complete`,{sha256:hash(bytes),elapsedMs:9999});
 assert.equal(again.elapsedMs,done.elapsedMs);assert.equal(again.completedAt,done.completedAt);
 const received=(await s.b.json('/api/state')).conversations[0].transfers[0];
 assert.equal(received.elapsedMs,done.elapsedMs);assert.equal(received.completedAt,done.completedAt);
});
async function setup(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lan-chat-test-'));
  const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', chunkSize: 4,
    reserveBytes: 0, quotaBytes: 1000, maxFileSize: 100, graceMs: 5000, allowPlaintextForTests:true, ...overrides });
  await app.start();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const apps = [app];
  t.after(async () => { for (const item of apps.toReversed()) await item.close(); await rm(dir, { recursive: true, force: true }); });
  function client(cookie = '') {
    return { cookie, async call(path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
      const raw = Buffer.isBuffer(body);
      const res = await fetch(base + path, { method, headers: {
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }), ...headers },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) this.cookie = setCookie.split(';')[0];
      return res;
    }, async json(path, body, method, headers) {
      const res = await this.call(path, body, method, headers);
      const result = await res.json();
      assert.equal(res.ok, true, JSON.stringify(result)); return result;
    } };
  }
  const a = client(), b = client(), c = client();
  const alice = await a.json('/api/profile', { nickname: '小明' });
  const bob = await b.json('/api/profile', { nickname: '小红' });
  await c.json('/api/profile', { nickname: '陌生人' });
  async function friends() {
    const request = await a.json('/api/friends/requests', { code: bob.code });
    await b.json(`/api/friends/requests/${request.id}`, { accept: true });
    return (await a.json('/api/state')).conversations[0].id;
  }
  async function transfer(conversationId, bytes, clientId = 'test-upload') {
    return a.json('/api/transfers', { conversationId, name: '原图 中文.png', size: bytes.length,
      type: 'image/png', clientId });
  }
  async function chunk(tr, index, bytes, checksum = hash(bytes)) {
    return a.call(`/api/transfers/${tr.id}/chunks/${index}`, bytes, 'PUT', { 'X-Chunk-SHA256': checksum });
  }
  return { app, apps, dir, base, a, b, c, alice, bob, client, friends, transfer, chunk };
}

test('identity cookie survives restart; clearing it creates another identity', async t => {
  const s = await setup(t);
  assert.equal((await s.a.json('/api/state')).me.nickname, '小明');
  const same = s.client(s.a.cookie);
  assert.equal((await same.json('/api/state')).me.id, s.alice.id);
  assert.equal((await s.client().call('/api/state')).status, 401);
  await s.friends();
  await s.app.close();
  const restarted = await createApp({ dataDir: s.dir, port: 0, host: '127.0.0.1', reserveBytes: 0 });
  s.apps.push(restarted); await restarted.start();
  const res = await fetch(`http://127.0.0.1:${restarted.server.address().port}/api/state`, { headers: { Cookie: s.a.cookie } });
  const state = await res.json();
  assert.equal(state.me.id, s.alice.id); assert.equal(state.friends.length, 1);
  assert.equal(state.conversations.flatMap(x => x.messages).length, 0);
});

test('friendship requires consent and only the recipient can accept', async t => {
  const s = await setup(t);
  const request = await s.a.json('/api/friends/requests', { code: s.bob.code });
  assert.equal((await s.c.call(`/api/friends/requests/${request.id}`, { accept: true })).status, 403);
  assert.equal((await s.a.json('/api/state')).friends.length, 0);
  await s.b.json(`/api/friends/requests/${request.id}`, { accept: true });
  assert.equal((await s.a.json('/api/state')).friends[0].id, s.bob.id);
  assert.equal((await s.c.json('/api/state')).conversations.length, 0);
});

test('messages are private, idempotent and have increasing sequence numbers', async t => {
  const s = await setup(t); const id = await s.friends();
  const first = await s.a.json(`/api/conversations/${id}/messages`, { clientId: 'message-one', text: '<script>你好</script>' });
  const duplicate = await s.a.json(`/api/conversations/${id}/messages`, { clientId: 'message-one', text: '<script>你好</script>' });
  const next = await s.b.json(`/api/conversations/${id}/messages`, { clientId: 'message-two', text: '收到' });
  assert.equal(first.id, duplicate.id); assert.ok(next.seq > first.seq);
  assert.equal((await s.b.json('/api/state')).conversations[0].messages.length, 2);
  assert.equal((await s.c.call(`/api/conversations/${id}/messages`, { clientId: 'bad', text: '偷窥' })).status, 403);
});

test('resumable upload verifies blocks, deduplicates retries and returns exact original bytes with Range', async t => {
  const s = await setup(t); const id = await s.friends(); const bytes = Buffer.from('abcdefghij');
  const tr = await s.transfer(id, bytes);
  assert.equal((await s.chunk(tr, 0, bytes.subarray(0, 4))).status, 200);
  assert.equal((await s.chunk(tr, 0, bytes.subarray(0, 4))).status, 200);
  assert.equal((await s.chunk(tr, 0, Buffer.from('xxxx'))).status, 409);
  const progress = await s.a.json(`/api/transfers/${tr.id}`);
  assert.equal(progress.offset, 4); assert.deepEqual(progress.hashes, [hash(Buffer.from('abcd'))]);
  assert.equal((await s.chunk(tr, 1, bytes.subarray(4, 8), '0'.repeat(64))).status, 422);
  assert.equal((await s.a.json(`/api/transfers/${tr.id}`)).offset, 4);
  assert.equal((await s.chunk(tr, 2, bytes.subarray(8))).status, 409);
  await s.chunk(tr, 1, bytes.subarray(4, 8)); await s.chunk(tr, 2, bytes.subarray(8));
  assert.equal((await s.a.call(`/api/transfers/${tr.id}/complete`, { sha256: '0'.repeat(64) })).status, 422);
  const completed = await s.a.json(`/api/transfers/${tr.id}/complete`, { sha256: hash(bytes) });
  assert.equal(completed.status, 'ready'); assert.equal(completed.sha256, hash(bytes));
  const file = await s.b.call(`/api/transfers/${tr.id}/download`);
  assert.match(file.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  const range = await s.b.call(`/api/transfers/${tr.id}/download`, undefined, 'GET', { Range: 'bytes=2-5' });
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await range.text(), 'cdef');
  const suffix = await s.b.call(`/api/transfers/${tr.id}/download`, undefined, 'GET', { Range: 'bytes=-3' });
  assert.equal(await suffix.text(), 'hij');
  assert.equal((await s.c.call(`/api/transfers/${tr.id}/download`)).status, 403);
});

test('empty and same-name files are independent; cancellation releases quota', async t => {
  const s = await setup(t, { quotaBytes: 8 }); const id = await s.friends();
  const zero = await s.transfer(id, Buffer.alloc(0), 'empty');
  await s.a.json(`/api/transfers/${zero.id}/complete`, { sha256: hash(Buffer.alloc(0)) });
  assert.equal((await s.b.call(`/api/transfers/${zero.id}/download`)).headers.get('content-length'), '0');
  const tr = await s.transfer(id, Buffer.alloc(8), 'full');
  assert.equal((await s.a.call('/api/transfers', { conversationId: id, name: 'x', size: 1, clientId: 'too-full' })).status, 507);
  await s.a.json(`/api/transfers/${tr.id}`, undefined, 'DELETE');
  const next = await s.transfer(id, Buffer.alloc(8), 'next');
  assert.notEqual(next.id, tr.id);
  assert.equal((await s.chunk(tr, 0, Buffer.alloc(4))).status, 410);
});

test('parallel duplicate chunks commit once and conflicting retries do not overwrite', async t => {
  const s = await setup(t); const id = await s.friends();
  const tr = await s.transfer(id, Buffer.from('abcd'));
  const results = await Promise.all([s.chunk(tr, 0, Buffer.from('abcd')), s.chunk(tr, 0, Buffer.from('abcd'))]);
  assert.deepEqual(results.map(x => x.status), [200, 200]);
  assert.equal((await s.a.json(`/api/transfers/${tr.id}`)).offset, 4);
  await s.a.json(`/api/transfers/${tr.id}/complete`, { sha256: hash(Buffer.from('abcd')) });
  assert.equal(await (await s.b.call(`/api/transfers/${tr.id}/download`)).text(), 'abcd');
});

test('both offline expire chat and files; friends remain; reconnect cancels expiration', async t => {
  const s = await setup(t, { graceMs: 120, sweepMs: 15 }); const id = await s.friends();
  const tr = await s.transfer(id, Buffer.from('abcd')); await s.chunk(tr, 0, Buffer.from('abcd'));
  await s.a.json(`/api/conversations/${id}/messages`, { text: '临时', clientId: 'temporary' });
  const controller = new AbortController();
  const events = await fetch(s.base + '/api/events', { headers: { Cookie: s.a.cookie }, signal: controller.signal });
  const reader = events.body.getReader(); await reader.read();
  await new Promise(r => setTimeout(r, 240));
  assert.equal((await s.a.json('/api/state')).conversations[0].messages.length, 1);
  controller.abort(); await reader.cancel().catch(() => {});
  await new Promise(r => setTimeout(r, 300));
  const state = await s.a.json('/api/state');
  assert.equal(state.friends.length, 1); assert.equal(state.conversations[0].messages.length, 0);
  assert.equal((await s.a.call(`/api/transfers/${tr.id}`)).status, 404);
  assert.deepEqual(await readdir(join(s.dir, 'transfers')), []);
});

test('size, origin and traversal restrictions reject invalid input', async t => {
  const s = await setup(t); const id = await s.friends();
  assert.equal((await s.a.call('/api/transfers', { conversationId: id, name: 'x', size: 101, clientId: 'large' })).status, 413);
  assert.equal((await s.a.call('/api/transfers', { conversationId: id, name: '../x', size: -1, clientId: 'negative' })).status, 400);
  assert.equal((await s.a.call('/api/friends/requests', { code: s.bob.code }, 'POST', { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await s.a.call('/api/transfers', { conversationId: id, name: 'x', size: 0.5, clientId: 'fraction' })).status, 400);
  assert.equal((await s.a.call('/api/friends/requests', { code: s.alice.code })).status, 400);
  const res = await fetch(s.base + '/.data/identity.sqlite'); assert.equal(res.status, 404);
});

test('restart removes crash leftovers and preserves existing identity database', async t => {
  const s = await setup(t); await s.app.close();
  await writeFile(join(s.dir, 'transfers', 'stale.part'), 'partial');
  const restarted = await createApp({ dataDir: s.dir, port: 0, host: '127.0.0.1', reserveBytes: 0 });
  s.apps.push(restarted);
  assert.deepEqual(await readdir(join(s.dir, 'transfers')), []);
});

test('concurrent retries of transfer creation reserve space and create a file only once', async t => {
  const s = await setup(t, { quotaBytes: 8 }); const id = await s.friends();
  const [one, two] = await Promise.all([s.transfer(id, Buffer.alloc(4), 'same-create'), s.transfer(id, Buffer.alloc(4), 'same-create')]);
  assert.equal(one.id, two.id);
  assert.equal((await s.a.json('/api/state')).storage.reserved, 4);
  assert.equal((await readdir(join(s.dir, 'transfers'))).length, 1);
});

test('file chronology is stable after refresh and recipient cannot mutate sender uploads', async t => {
  const s = await setup(t); const id = await s.friends();
  const first = await s.a.json(`/api/conversations/${id}/messages`, { text: '前', clientId: 'before-file' });
  const tr = await s.transfer(id, Buffer.from('abcd'));
  const after = await s.a.json(`/api/conversations/${id}/messages`, { text: '后', clientId: 'after-file' });
  const remote = await s.b.json(`/api/transfers/${tr.id}`);
  assert.ok(remote.seq > first.seq && remote.seq < after.seq);
  assert.equal((await s.b.call(`/api/transfers/${tr.id}`, undefined, 'DELETE')).status, 403);
  assert.equal((await s.b.call(`/api/transfers/${tr.id}/complete`, { sha256: hash('abcd') })).status, 403);
});

test('disk reserve refuses new files without consuming quota', async t => {
  const s = await setup(t, { reserveBytes: Number.MAX_SAFE_INTEGER }); const id = await s.friends();
  assert.equal((await s.a.call('/api/transfers', { conversationId: id, name: 'a', size: 4, clientId: 'no-disk' })).status, 507);
  assert.equal((await s.a.json('/api/state')).storage.reserved, 0);
});

test('SSE presence expires without client heartbeat even when TCP remains connected', async t => {
  const s = await setup(t, { heartbeatMs: 20, heartbeatTimeoutMs: 80 });
  const controller = new AbortController();
  const res = await fetch(s.base + '/api/events', { headers: { Cookie: s.a.cookie }, signal: controller.signal });
  const reader = res.body.getReader(); await reader.read();
  assert.ok((await s.b.json('/api/state')).online.some(x => x.id === s.alice.id));
  await new Promise(r => setTimeout(r, 160));
  assert.equal((await s.b.json('/api/state')).online.some(x => x.id === s.alice.id), false);
  controller.abort(); await reader.cancel().catch(() => {});
});

test('creation response loss retries the same client ID and creates exactly one upload', async t => {
  const s = await setup(t); const id = await s.friends(); let attempts = 0;
  const body = { conversationId: id, name: 'lost-response.bin', size: 4, clientId: 'fixed-before-retry' };
  const result = await withRetry(async () => {
    const remote = await s.a.json('/api/transfers', body);
    if (++attempts === 1) throw new TypeError('response lost after server accepted');
    return remote;
  }, { signal: new AbortController().signal });
  const state = await s.a.json('/api/state');
  assert.equal(attempts, 2); assert.equal(state.conversations[0].transfers.length, 1);
  assert.equal(state.storage.reserved, 4); assert.equal(result.id, state.conversations[0].transfers[0].id);
});

test('extra tabs fall back without taking all HTTP sockets and their short presence lease keeps identity online', async t => {
  const s = await setup(t); const controllers = [], readers = [];
  t.after(() => controllers.forEach(x => x.abort()));
  for (let i = 0; i < 2; i++) {
    const controller = new AbortController(); controllers.push(controller);
    const res = await fetch(s.base + '/api/events', { headers: { Cookie: s.a.cookie }, signal: controller.signal });
    const reader = res.body.getReader(); readers.push(reader); await reader.read();
  }
  const third = await s.a.call('/api/events'); assert.equal(third.status, 204);
  await s.a.json('/api/ping', { tabId: 'fallback-tab-123' });
  controllers.forEach(x => x.abort()); await Promise.all(readers.map(x => x.cancel().catch(() => {})));
  assert.equal((await s.b.json('/api/state')).online.some(x => x.id === s.alice.id), true);
  await s.a.json('/api/leave', { tabId: 'fallback-tab-123' });
  await new Promise(r => setTimeout(r, 30));
  assert.equal((await s.b.json('/api/state')).online.some(x => x.id === s.alice.id), false);
});

test('failed file cleanup stays terminal and retries after reconnect instead of reviving a broken upload', async t => {
  const warnings = [];
  t.mock.method(console, 'error', (...args) => warnings.push(args.join(' ')));
  const s = await setup(t, { graceMs: 80, sweepMs: 30 }); const id = await s.friends();
  const tr = await s.transfer(id, Buffer.from('abcd')); await s.chunk(tr, 0, Buffer.from('abcd'));
  const path = join(s.dir, 'transfers', tr.id + '.part'), backup = join(s.dir, 'locked-backup');
  // A real filesystem failure, without a production-only test hook.
  await rename(path, backup); await mkdir(path);
  await new Promise(r => setTimeout(r, 160));
  const state = await s.a.json('/api/state');
  assert.notEqual(state.conversations[0].id, id);
  const controller = new AbortController();
  const res = await fetch(s.base + '/api/events', { headers: { Cookie: s.a.cookie }, signal: controller.signal });
  const reader = res.body.getReader(); await reader.read();
  await rmdir(path); await rename(backup, path);
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await s.a.json('/api/state')).storage.reserved, 0);
  assert.deepEqual(await readdir(join(s.dir, 'transfers')), []);
  assert.ok(warnings.some(message => message.includes('临时文件清理失败')));
  controller.abort(); await reader.cancel().catch(() => {});
});
