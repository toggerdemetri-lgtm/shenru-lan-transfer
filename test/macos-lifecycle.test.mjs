import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createSocket } from 'node:dgram';

const entry = resolve('desktop-macos.mjs');
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await delay(35); }
  throw Error('Timed out waiting for macOS lifecycle');
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'shenru-macos-'));
  const children = [];
  const probe = createSocket('udp4'); await new Promise(r => probe.bind(0, '127.0.0.1', r)); const discoveryPort = probe.address().port; await new Promise(r => probe.close(r));
  t.after(async () => { for (const p of children) if (p.exitCode === null && p.signalCode === null) p.kill(); await Promise.all(children.map(p => p.exitCode !== null || p.signalCode !== null ? null : new Promise(r => p.once('exit', r)))); await rm(root, { recursive: true, force: true }); });
  let counter = 0;
  async function launch(extra = {}) {
    const sessionDir = join(root, 'sessions', String(counter++)); await mkdir(sessionDir, { recursive: true });
    const settings = { homeDir: root, sessionDir, entryPath: join(root, '深入·局域网互传.html'), port: 0, host: '127.0.0.1', probeLocal: false, electionMs: 0, discoveryPort, ...extra };
    const config = join(sessionDir, 'settings.json'); await writeFile(config, JSON.stringify(settings));
    const p = spawn(process.execPath, [entry, config], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(p);
    let errors = ''; p.stderr.on('data', x => { errors += x; }); p.stdout.resume();
    const status = async () => { try { return JSON.parse(await readFile(join(sessionDir, 'status.json'), 'utf8')); } catch { return null; } };
    return { p, settings, status, errors: () => errors, ready: () => until(async () => { const s = await status(); if (s?.state === 'error' || p.exitCode) throw Error(s?.error || errors); return s?.state === 'ready' || s?.role === 'duplicate' ? s : null; }), exited: () => until(() => p.exitCode !== null || p.signalCode !== null) };
  }
  return { root, launch };
}

test('macOS primary writes HTML, duplicate reopens single instance, EOF closes host, restart works', async t => {
  const { root, launch } = await fixture(t);
  const primary = await launch(); const first = await primary.ready();
  assert.equal(first.role, 'primary'); assert.equal(first.mode, 'host');
  assert.match(await readFile(first.entryPath, 'utf8'), /127\.0\.0\.1/);
  assert.equal((await fetch(new URL('/api/service-info', first.url))).status, 200);
  const duplicate = await launch(); const second = await duplicate.ready();
  assert.equal(second.role, 'duplicate'); await duplicate.exited();
  const reopened = await until(async () => { const s = await primary.status(); return s.openRequest > first.openRequest ? s : null; });
  assert.equal(reopened.bootId, first.bootId);
  primary.p.stdin.end(); await primary.exited(); assert.equal(primary.p.exitCode, 0, primary.errors());
  await assert.rejects(fetch(new URL('/api/service-info', first.url)));
  const next = await launch(); assert.equal((await next.ready()).role, 'primary'); next.p.stdin.end(); await next.exited();
  assert.ok(root);
});

test('macOS joined instance EOF leaves the remote host running', async t => {
  const { launch } = await fixture(t);
  const host = await launch(); const remote = await host.ready();
  const joiner = await launch({ homeDir: join(host.settings.homeDir, 'other-home'), port: new URL(remote.url).port * 1, probeLocal: true });
  const joined = await joiner.ready(); assert.equal(joined.mode, 'join'); assert.equal(joined.bootId, remote.bootId);
  joiner.p.stdin.end(); await joiner.exited();
  assert.equal((await fetch(new URL('/api/service-info', remote.url))).status, 200);
  host.p.stdin.end(); await host.exited();
});

test('macOS cancellation during startup and abrupt child death do not prevent restart', async t => {
  const { launch } = await fixture(t);
  const early = await launch(); early.p.stdin.end(); await early.exited(); assert.equal(early.p.exitCode, 0, early.errors());
  const primary = await launch(); await primary.ready(); primary.p.kill('SIGKILL'); await primary.exited();
  const next = await launch(); assert.equal((await next.ready()).mode, 'host'); next.p.stdin.end(); await next.exited();
});

test('macOS adjacent HTML failure falls back into per-user data directory', async t => {
  const { root, launch } = await fixture(t);
  const primary = await launch({ entryPath: root }); const result = await primary.ready();
  assert.equal(result.entryPath, join(root, 'Library', 'Application Support', 'Shenru', 'data', '深入·局域网互传.html'));
  assert.match(result.warning, /入口/); primary.p.stdin.end(); await primary.exited();
});

test('macOS simultaneous launches produce one primary and authenticated reopen requests', async t => {
  const { root, launch } = await fixture(t);
  const launches = await Promise.all(Array.from({ length: 5 }, () => launch()));
  const results = await Promise.all(launches.map(x => x.ready()));
  assert.equal(results.filter(x => x.role === 'primary').length, 1);
  assert.equal(results.filter(x => x.role === 'duplicate').length, 4);
  const primary = launches[results.findIndex(x => x.role === 'primary')];
  const meta = JSON.parse(await readFile(join(root, 'Library', 'Application Support', 'Shenru', 'desktop-control.json'), 'utf8'));
  const before = (await primary.status()).openRequest;
  const response = await fetch(`http://127.0.0.1:${meta.port}/open`, { method: 'POST', headers: { Authorization: 'Bearer wrong-token' } });
  assert.equal(response.status, 403); assert.equal((await primary.status()).openRequest, before);
  primary.p.stdin.write('st'); primary.p.stdin.write('op\n'); await primary.exited();
  assert.equal(primary.p.exitCode, 0, primary.errors());
  await Promise.all(launches.filter(x => x !== primary).map(x => x.exited()));
});

test('macOS startup failure releases ownership so the next launch succeeds', async t => {
  const { launch } = await fixture(t);
  const failed = await launch({ port: -1 });
  await assert.rejects(failed.ready(), /端口/); await failed.exited();
  assert.equal(failed.p.exitCode, 1);
  const primary = await launch(); assert.equal((await primary.ready()).role, 'primary'); primary.p.stdin.end(); await primary.exited();
});
