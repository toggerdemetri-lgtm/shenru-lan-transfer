import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { Script } from 'node:vm';
import { createHash } from 'node:crypto';

test('real private LAN address takes priority over proxy virtual addresses', async () => {
  const { lanAddresses } = await import('../lib/entry.mjs');
  const result = lanAddresses(3000, { Proxy: [{ family: 'IPv4', address: '198.18.0.1', internal: false }], WiFi: [{ family: 'IPv4', address: '192.168.1.21', internal: false }] });
  assert.equal(result[0], 'http://192.168.1.21:3000/');
});

test('LAN entry prioritizes physical networks over TUN and VPN aliases', async t => {
  const { lanAddresses, renderEntry } = await import('../lib/entry.mjs');
  const ipv4 = address => [{ family: 'IPv4', address, internal: false }];
  for (const name of ['tun0', 'utun3', 'TUN', 'TAP-Windows Adapter V9', 'sing-tun Tunnel', 'Wintun', 'wg0', 'WireGuard', 'Tailscale', 'ZeroTier One', 'vEthernet (Default Switch)', 'VMware Network Adapter VMnet8', 'vboxnet0', 'vmnet8']) {
    await t.test(name, () => {
      const addresses = lanAddresses(3000, { [name]: ipv4('172.19.0.1'), '以太网': ipv4('192.168.1.21') });
      assert.deepEqual(addresses, ['http://192.168.1.21:3000/', 'http://172.19.0.1:3000/']);
    });
  }
  await t.test('legitimate 172 LAN is retained and used as the HTML default', () => {
    const addresses = lanAddresses(3000, { utun8: ipv4('10.7.0.2'), en0: ipv4('172.19.0.21') });
    assert.equal(addresses[0], 'http://172.19.0.21:3000/');
    const html = renderEntry(addresses);
    assert.deepEqual(JSON.parse(/const addresses=(\[[^;]+\]);/.exec(html)[1]), addresses);
  });
  await t.test('physical interface precedes private tunnel even outside RFC1918', () => {
    assert.equal(lanAddresses(3000, { tun0: ipv4('10.0.0.1'), en0: ipv4('100.64.1.2') })[0], 'http://100.64.1.2:3000/');
  });
  await t.test('tunnel-only networks remain usable and unrelated names are not TUN aliases', () => {
    assert.deepEqual(lanAddresses(3000, { tun0: ipv4('172.19.0.1') }), ['http://172.19.0.1:3000/']);
    assert.equal(lanAddresses(3000, { 'Tundra WiFi': ipv4('10.1.2.3'), Ethernet: ipv4('192.168.1.21') })[0], 'http://10.1.2.3:3000/');
  });
});

test('share HTML is standalone, escapes addresses and rejects executable URLs', async () => {
  const { renderEntry } = await import('../lib/entry.mjs');
  const html = renderEntry(['http://192.168.1.7:3000']);
  assert.ok(html.includes('http://192.168.1.7:3000/'));
  assert.ok(html.includes('进入深入·局域网互传'));
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Script(script[1]));
  assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:src|href)=["']https?:/);
  assert.throws(() => renderEntry(['javascript:alert(1)']));
  assert.throws(() => renderEntry(['http://user:password@192.168.1.7:3000/']));
  assert.throws(() => renderEntry(['http://192.168.1.7:3000/?x=<script>']));
  assert.ok(renderEntry([]).includes('先启动'));
});

test('public service identification and downloadable HTML preserve origin protections', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shenru-entry-'));
  const app = await createApp({ port: 0, host: '127.0.0.1', dataDir: dir });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  await app.start();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const page = await fetch(base + '/');
  const bootStyle = /<style id="boot-colors">([^<]+)<\/style>/.exec(await page.text())?.[1];
  assert.ok(bootStyle, 'critical initial dark background must be present');
  assert.match(bootStyle, /--nebula-image:url\("data:image\/jpeg;base64,/, 'first paint must include the complete background without another image request');
  const headPage=await fetch(base+'/',{method:'HEAD'});
  assert.equal(headPage.headers.get('content-length'), page.headers.get('content-length'));
  assert.ok(page.headers.get('content-security-policy').includes('sha256-' + createHash('sha256').update(bootStyle).digest('base64')));
  assert.ok(!page.headers.get('content-security-policy').includes('unsafe-inline'));
  const info = await (await fetch(base + '/api/service-info')).json();
  assert.equal(info.app, 'shenru-lan');
  assert.equal(info.protocol, 1);
  assert.ok(info.bootId);
  const entry = await fetch(base + '/share.html');
  assert.equal(entry.status, 200);
  assert.match(entry.headers.get('content-disposition'), /attachment/);
  const downloaded = await entry.text();
  assert.match(downloaded, /进入深入·局域网互传/);
  assert.ok(downloaded.includes(base + '/'), 'loopback server must export its verified bound address');
  assert.equal((await fetch(base + '/api/profile', { method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: '{"nickname":"x"}' })).status, 403);
  assert.equal((await fetch(base + '/api/profile', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{"nickname":"x"}' })).status, 403);
});
