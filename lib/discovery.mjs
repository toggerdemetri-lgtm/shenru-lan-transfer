import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';

const GROUP = '239.255.67.89';
const MAGIC = 'shenru-lan-discovery-v1';
export const DISCOVERY_PORT = 42376;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function verifyService(address, port, bootId) {
  if (isIP(address) !== 4 || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  try {
    const url = `http://${address}:${port}/`;
    const response = await fetch(url + 'api/service-info', { signal: AbortSignal.timeout(700), redirect: 'error' });
    if (!response.ok || Number(response.headers.get('content-length')) > 4096) return null;
    const text = await response.text(); if (text.length > 4096) return null;
    const info = JSON.parse(text);
    return info.app === 'shenru-lan' && info.protocol === 1 && info.contentEncryption === 1 && typeof info.bootId === 'string' && (!bootId || info.bootId === bootId) ? { ...info, url } : null;
  } catch { return null; }
}

export async function createDiscovery({ port = DISCOVERY_PORT, id = randomUUID(), startedAt = Date.now() } = {}) {
  const listener = createSocket({ type: 'udp4', reuseAddr: true });
  const probe = createSocket('udp4');
  const peers = new Map();
  let record = { id, startedAt, state: 'candidate', port: 0 }, closed = false, failure = '';
  const nets = Object.values(networkInterfaces()).flat().filter(n => n?.family === 'IPv4' && !n.internal);
  const targets = new Set(['127.0.0.1', GROUP, '255.255.255.255']);
  for (const net of nets) {
    const ip = net.address.split('.').map(Number), mask = net.netmask.split('.').map(Number);
    targets.add(ip.map((v, i) => v | (255 ^ mask[i])).join('.'));
  }
  const send = (socket, data, address, remotePort) => {
    if (!closed) socket.send(Buffer.from(JSON.stringify({ magic: MAGIC, ...data })), remotePort, address, () => {});
  };
  function parse(bytes) {
    if (bytes.length > 2048) return null;
    try { const x = JSON.parse(bytes); return x.magic === MAGIC ? x : null; } catch { return null; }
  }
  listener.on('message', (bytes, from) => {
    const packet = parse(bytes);
    if (packet?.type === 'query') send(listener, { type: 'peer', ...record }, from.address, from.port);
  });
  probe.on('message', (bytes, from) => {
    const x = parse(bytes);
    if (x?.type !== 'peer' || x.id === id || typeof x.id !== 'string' || x.id.length > 100 ||
        !Number.isSafeInteger(x.startedAt) || !['candidate', 'host'].includes(x.state) ||
        !Number.isInteger(x.port) || x.port < 0 || x.port > 65535) return;
    // Prefer a reachable LAN source over loopback when several interfaces reply.
    const previous = peers.get(x.id);
    const rank = address => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) ? 2 : address.startsWith('127.') ? 0 : 1;
    if (previous && rank(previous.address) > rank(from.address)) { peers.set(x.id, { ...x, address: previous.address, seenAt: Date.now() }); return; }
    peers.set(x.id, { ...x, address: from.address, seenAt: Date.now() });
  });
  listener.on('error', e => { failure = e.message; });
  probe.on('error', e => { failure = e.message; });
  try {
    await new Promise((ok, reject) => { listener.once('error', reject); listener.bind(port, '0.0.0.0', () => { listener.removeListener('error', reject); ok(); }); });
    await new Promise((ok, reject) => { probe.once('error', reject); probe.bind(0, '0.0.0.0', () => { probe.removeListener('error', reject); ok(); }); });
    probe.setBroadcast(true); probe.setMulticastTTL(1); probe.setMulticastLoopback(true);
    for (const net of [{ address: '127.0.0.1' }, ...nets]) try { listener.addMembership(GROUP, net.address); } catch {}
  } catch (e) { try { listener.close(); } catch {} try { probe.close(); } catch {} throw Error('局域网发现端口不可用：' + e.message); }
  function query() {
    for (const address of targets) send(probe, { type: 'query' }, address, port);
    for (const net of nets) try { probe.setMulticastInterface(net.address); send(probe, { type: 'query' }, GROUP, port); } catch {}
    try { probe.setMulticastInterface('0.0.0.0'); } catch {}
  }
  const timer = setInterval(query, 220); query();
  return {
    id, startedAt, peers,
    get warning() { return failure; },
    host(servicePort, bootId) { record = { ...record, state: 'host', port: servicePort, bootId }; query(); },
    async scan(ms) { query(); await sleep(ms); return [...peers.values()].filter(p => Date.now() - p.seenAt < 2000); },
    close() { if (closed) return; closed = true; clearInterval(timer); listener.close(); probe.close(); }
  };
}
