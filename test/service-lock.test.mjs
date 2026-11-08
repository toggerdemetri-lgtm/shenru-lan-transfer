import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

const cleanups = new WeakMap();
const cleanup = (t, callback) => cleanups.get(t).push(callback);

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'shenru-lock-test-'));
  cleanups.set(t, []);
  t.after(async () => {
    for (const callback of cleanups.get(t).toReversed()) await callback();
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function childOwner(t, dir) {
  const source = `import { createApp } from ${JSON.stringify(new URL('../server.mjs', import.meta.url).href)};
    try { const app = await createApp({ dataDir: process.argv[1] });
      process.send({ acquired: true }); process.on('message', async () => { await app.close(); process.exit(0); });
    } catch (error) { process.send({ acquired: false, status: error.status, error: error.message }); process.exit(0); }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  cleanup(t, async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
  const result = await Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(([code]) => { throw new Error(`lock child exited ${code}: ${stderr}`); })
  ]);
  return { child, result };
}

test('legacy PID reuse is recovered when the lock predates the live process', async t => {
  const dir = await directory(t), path = join(dir, 'server.lock');
  await writeFile(path, String(process.pid));
  const beforeProcess = new Date(Date.now() - process.uptime() * 1000 - 60_000);
  await utimes(path, beforeProcess, beforeProcess);
  const app = await createApp({ dataDir: dir }); cleanup(t, () => app.close());
  assert.ok(app.serviceInfo.bootId);
});

test('ambiguous live legacy PID refuses startup and preserves active transfers', async t => {
  const dir = await directory(t);
  await mkdir(join(dir, 'transfers')); await writeFile(join(dir, 'transfers', 'keep.part'), 'active data');
  await writeFile(join(dir, 'server.lock'), String(process.pid));
  await assert.rejects(createApp({ dataDir: dir }), error => error.status === 409);
  assert.equal(await readFile(join(dir, 'transfers', 'keep.part'), 'utf8'), 'active data');
});

test('legacy reuse recovery reads a different live process start time', async t => {
  const ownerDir = await directory(t), owner = await childOwner(t, ownerDir);
  assert.equal(owner.result.acquired, true);
  const dir = await mkdtemp(join(tmpdir(), 'shenru-legacy-lock-test-'));
  cleanup(t, () => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'server.lock'), earlier = new Date(Date.now() - 60_000);
  await writeFile(path, String(owner.child.pid)); await utimes(path, earlier, earlier);
  const app = await createApp({ dataDir: dir }); cleanup(t, () => app.close());
  assert.ok(app.serviceInfo.bootId);
});

test('simultaneous acquisitions in one process admit exactly one owner', async t => {
  const dir = await directory(t);
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => createApp({ dataDir: dir })));
  const owners = attempts.filter(item => item.status === 'fulfilled').map(item => item.value);
  cleanup(t, async () => { for (const owner of owners) await owner.close(); });
  assert.equal(owners.length, 1);
  for (const result of attempts.filter(item => item.status === 'rejected')) assert.equal(result.reason.status, 409);
});

test('different processes cannot acquire the same live service directory', async t => {
  const dir = await directory(t), first = await childOwner(t, dir);
  assert.equal(first.result.acquired, true);
  const second = await childOwner(t, dir);
  assert.deepEqual(second.result.acquired, false); assert.equal(second.result.status, 409);
  await assert.rejects(createApp({ dataDir: dir }), error => error.status === 409);
});

test('simultaneous fresh-directory acquisitions across processes admit one owner', async t => {
  const dir = await directory(t);
  const attempts = await Promise.all(Array.from({ length: 4 }, () => childOwner(t, dir)));
  assert.equal(attempts.filter(item => item.result.acquired).length, 1);
  for (const item of attempts.filter(item => !item.result.acquired)) assert.equal(item.result.status, 409);
});

test('process death releases ownership even if the stale marker PID is now alive', async t => {
  const dir = await directory(t), first = await childOwner(t, dir);
  assert.equal(first.result.acquired, true);
  const exited = once(first.child, 'exit'); first.child.kill(); await exited;
  const markerPath = join(dir, 'server.lock');
  // Old versions use a numeric file; the upgraded atomic marker is a directory.
  // A stale PID inside the new marker cannot become an ownership authority.
  if ((await stat(markerPath)).isDirectory()) await writeFile(join(markerPath, 'pid'), String(process.pid));
  else await writeFile(markerPath, String(process.pid));
  const app = await createApp({ dataDir: dir }); cleanup(t, () => app.close());
  assert.ok(app.serviceInfo.bootId);
});

test('normal close releases ownership and a repeated old close cannot release the next owner', async t => {
  const dir = await directory(t), first = await createApp({ dataDir: dir });
  await first.close();
  const next = await createApp({ dataDir: dir }); cleanup(t, () => next.close());
  await first.close();
  await assert.rejects(createApp({ dataDir: dir }), error => error.status === 409);
});
