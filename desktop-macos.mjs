import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startPortable } from './portable.mjs';
import { renderEntry } from './lib/entry.mjs';

async function atomicJSON(path, value) {
  const pending = path + '.' + process.pid + '.tmp';
  await writeFile(pending, JSON.stringify(value), { mode: 0o600 });
  await rename(pending, path);
}

// A listening socket is the lock. The OS releases it even after SIGKILL; stale
// PID files are never deleted while another launch might already own them.
export async function runMacDesktop(settings, input = process.stdin) {
  const base = join(settings.homeDir || homedir(), 'Library', 'Application Support', 'Shenru');
  const dataDir = join(base, 'data');
  const sessionDir = settings.sessionDir;
  if (!sessionDir) throw Error('Missing private launcher session directory');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const statusPath = join(sessionDir, 'status.json');
  const controlPath = join(base, 'desktop-control.json');
  const identity = createHash('sha256').update(resolve(base)).digest('hex');
  const controlPort = settings.controlPort ?? (40000 + parseInt(identity.slice(0, 8), 16) % 20000);
  let stopping = false, runtime, server, token, result, openRequest = 0;
  let updates = Promise.resolve();
  const publish = value => { updates = updates.then(() => atomicJSON(statusPath, value)); return updates; };
  let finish;
  const ended = new Promise(r => { finish = r; });
  const requestStop = () => { stopping = true; finish(); };
  let commands = '';
  const onData = value => { commands += value.toString(); if (commands.includes('stop')) requestStop(); if (commands.length > 4096) commands = commands.slice(-32); };
  input.on('data', onData); input.on('end', requestStop); input.resume();
  process.on('SIGTERM', requestStop); process.on('SIGINT', requestStop);
  if (input.readableEnded) requestStop();
  try {
    if (stopping) return;
    server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/open' || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403); res.end(); return; }
      if (stopping) { res.writeHead(503); res.end(); return; }
      openRequest++;
      if (result) publish({ ...result, openRequest }).catch(requestStop);
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ app: 'shenru-desktop', identity, role: 'duplicate', state: result ? 'ready' : 'starting' }));
    });
    try { await new Promise((ok, fail) => { server.once('error', fail); server.listen(controlPort, '127.0.0.1', () => { server.removeListener('error', fail); ok(); }); }); }
    catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      server = null;
      for (let n = 0; n < 100 && !stopping; n++) {
        try {
          const owner = JSON.parse(await readFile(controlPath, 'utf8'));
          if (owner.identity !== identity || owner.port !== controlPort) throw Error('control mismatch');
          const response = await fetch(`http://127.0.0.1:${controlPort}/open`, { method: 'POST', headers: { Authorization: `Bearer ${owner.token}` }, signal: AbortSignal.timeout(400) });
          const existing = await response.json();
          if (response.ok && existing.app === 'shenru-desktop' && existing.identity === identity) { await publish(existing); return; }
        } catch { /* The primary may still be publishing its endpoint. */ }
        await delay(60);
      }
      if (stopping) return;
      throw Error('本机深入·局域网互传控制端口正被占用，请稍后重试。');
    }
    server.on('error', requestStop);
    token = randomBytes(32).toString('hex');
    await atomicJSON(controlPath, { identity, port: controlPort, token, pid: process.pid });
    if (stopping) return;
    await publish({ state: 'starting', role: 'primary' });
    runtime = await startPortable({ dataDir, port: settings.port ?? 3000, discoveryPort: settings.discoveryPort, host: settings.host, probeLocal: settings.probeLocal, electionMs: settings.electionMs });
    if (stopping) return;
    let entryPath = settings.entryPath || join(dirname(settings.appPath || dirname(fileURLToPath(import.meta.url))), '深入·局域网互传.html');
    let entryWarning = '';
    try { await writeFile(entryPath, renderEntry(runtime.addresses), 'utf8'); }
    catch { entryPath = join(dataDir, '深入·局域网互传.html'); await writeFile(entryPath, renderEntry(runtime.addresses), 'utf8'); entryWarning = '应用所在文件夹不可写，入口已保存到：' + entryPath; }
    result = { state: 'ready', role: 'primary', mode: runtime.mode, url: runtime.url, bootId: runtime.bootId, addresses: runtime.addresses, entryPath, entryURL: pathToFileURL(entryPath).href, warning: [runtime.warning, entryWarning].filter(Boolean).join('\n') };
    openRequest++;
    await publish({ ...result, openRequest });
    await ended;
  } catch (e) {
    await publish({ state: 'error', error: e.message }).catch(() => {});
    throw e;
  } finally {
    stopping = true;
    await runtime?.close();
    if (server?.listening) {
      await new Promise(r => { server.close(r); server.closeAllConnections(); });
      // Keep the last endpoint metadata. A successor overwrites it only after
      // acquiring the socket, avoiding an unlink race with a new owner.
    }
    await updates;
    input.removeListener('data', onData); input.removeListener('end', requestStop); input.pause();
    process.removeListener('SIGTERM', requestStop); process.removeListener('SIGINT', requestStop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runMacDesktop(JSON.parse(await readFile(process.argv[2], 'utf8'))); }
  catch (e) { console.error(e.stack || e.message); process.exitCode = 1; }
}
