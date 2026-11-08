import { createApp } from './server.mjs';
import { createDiscovery, verifyService } from './lib/discovery.mjs';
import { lanAddresses, renderEntry } from './lib/entry.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export async function startPortable(options = {}) {
  const port = options.port ?? 3000;
  const startedAt = options.startedAt ?? Date.now();
  const id = options.id || randomUUID();
  const electionMs = options.electionMs ?? 1600;
  let discovery, app, discoveryWarning = '';
  async function joined(info, warning = '') {
    discovery?.close();
    const parsed = new URL(info.url);
    let addresses = [info.url];
    if (parsed.hostname.startsWith('127.')) {
      const candidates = lanAddresses(Number(parsed.port));
      const checked = await Promise.all(candidates.map(u => verifyService(new URL(u).hostname, Number(parsed.port), info.bootId)));
      addresses = checked.filter(Boolean).map(x => x.url);
      if (!addresses.length) { addresses = [info.url]; warning = '当前旧服务仅允许本机访问，朋友无法连接。请先关闭旧服务，再重新打开深入·局域网互传应用。'; }
    }
    return { mode: 'join', url: addresses[0] || info.url, addresses: addresses.length ? addresses : [info.url], bootId: info.bootId, warning, async close() {} };
  }
  // Also reuse the legacy launcher already running on this computer.
  if (options.probeLocal !== false && port) {
    const existing = await verifyService('127.0.0.1', port);
    if (existing) return joined(existing);
  }
  try {
    try { discovery = await (options.discoveryFactory || createDiscovery)({ port: options.discoveryPort, startedAt, id }); }
    catch (e) { discoveryWarning = '自动发现暂不可用，当前电脑仍可提供服务。请把更新后的 HTML 入口发给朋友连接。原因：' + e.message; }
    const scanStarted = Date.now();
    while (discovery && Date.now() - scanStarted < electionMs + 3500) {
      const peers = await discovery.scan(240);
      const hosts = peers.filter(p => p.state === 'host').sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
      for (const peer of hosts) {
        const info = await verifyService(peer.address, peer.port, peer.bootId);
        if (info) return joined(info);
      }
      if (Date.now() - scanStarted < electionMs) continue;
      const earlier = peers.some(p => p.state === 'candidate' && (p.startedAt < startedAt || (p.startedAt === startedAt && p.id < id)));
      if (!earlier) break;
    }
    const config = { ...options, startedAt, port, host: options.host || '0.0.0.0' };
    app = await createApp(config);
    try { await app.start(); }
    catch (e) {
      await app.close(); app = null;
      if (e.code !== 'EADDRINUSE') throw e;
      const existing = await verifyService('127.0.0.1', port);
      if (existing) return joined(existing);
      app = await createApp({ ...config, port: 0 }); await app.start();
    }
    const boundPort = app.server.address().port;
    discovery?.host(boundPort, app.serviceInfo.bootId);
    // Give another candidate already entering its final probe time to see this host.
    const urls = options.host === '127.0.0.1' ? [] : lanAddresses(boundPort);
    const url = urls[0] || `http://127.0.0.1:${boundPort}/`;
    let closed = false;
    return { mode: 'host', url, addresses: urls.length ? urls : [url], bootId: app.serviceInfo.bootId, warning: discoveryWarning || discovery?.warning || '',
      async close() { if (closed) return; closed = true; discovery?.close(); await app.close(); } };
  } catch (e) { discovery?.close(); await app?.close(); throw e; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let running;
  try {
    const settings = JSON.parse(await (await import('node:fs/promises')).readFile(process.argv[2], 'utf8'));
    await mkdir(settings.dataDir, { recursive: true });
    running = await startPortable({ dataDir: settings.dataDir, port: settings.port ?? 3000, discoveryPort: settings.discoveryPort });
    let entryPath = settings.entryPath, entryWarning = '';
    try { await writeFile(entryPath, renderEntry(running.addresses), 'utf8'); }
    catch { entryPath = join(settings.dataDir, '深入·局域网互传.html'); await writeFile(entryPath, renderEntry(running.addresses), 'utf8'); entryWarning = 'EXE 所在文件夹不可写，入口已保存到：' + entryPath; }
    const result = { mode: running.mode, url: running.url, bootId: running.bootId, addresses: running.addresses, entryPath, warning: [running.warning, entryWarning].filter(Boolean).join('\n') };
    await writeFile(settings.resultPath, JSON.stringify(result), 'utf8');
    console.log(JSON.stringify(result));
    // The parent controls lifetime over stdin, including graceful cleanup on exit.
    process.stdin.setEncoding('utf8');
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; await running.close(); process.exit(0); };
    process.stdin.on('data', text => { if (text.includes('stop')) stop(); });
    process.stdin.on('end', stop); process.on('SIGTERM', stop); process.on('SIGINT', stop);
    process.stdin.resume();
  } catch (e) { console.error(e.stack || e.message); await running?.close(); process.exitCode = 1; }
}
