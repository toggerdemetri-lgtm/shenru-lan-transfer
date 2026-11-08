import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { selectPortableSmokeArchive } from './portable-smoke-archive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archive = await selectPortableSmokeArchive(root, process.argv.slice(2));
await mkdir(join(root, '.qa'), { recursive: true });
const work = await mkdtemp(join(root, '.qa', 'portable-smoke-'));
const release = join(work, 'release');
const quote = x => "'" + x.replaceAll("'", "''") + "'";
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${quote(archive)},${quote(release)})`], { windowsHide: true });
assert.deepEqual((await readdir(release)).sort(), ['使用说明.txt', '深入·局域网互传.exe', '深入·局域网互传.html'].sort());
const binary = await readFile(join(release, '深入·局域网互传.exe'));
assert.equal(binary.readUInt16LE(binary.readUInt32LE(0x3c) + 24 + 68), 2, 'GUI subsystem must not create a console');
const port = String(44000 + Math.floor(Math.random() * 9000));
const processes = [];
const desktopStarted = new Date().toISOString();
await writeFile(join(root, '.qa', 'portable-smoke-report.json'), JSON.stringify({ passed: false, status: 'running', archive, startedAt: desktopStarted }, null, 2));
function powershell(code) { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; $env:PSModulePath=Join-Path $PSHOME 'Modules'; " + code], { encoding: 'utf8', windowsHide: true }); }
const explorerBefore = powershell("@(Get-Process -Name explorer -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) | ConvertTo-Json -Compress").trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function launch(home, duration = 9000) {
  const process = spawn(join(release, '深入·局域网互传.exe'), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...globalThis.process.env,
    SHENRU_HOME: join(work, home), SHENRU_NO_BROWSER: '1', SHENRU_AUTO_EXIT_MS: String(duration), SHENRU_PORT: '0', SHENRU_DISCOVERY_PORT: port } });
  process.output = ''; process.errorOutput = '';
  process.stdout.setEncoding('utf8').on('data', text => process.output += text);
  process.stderr.setEncoding('utf8').on('data', text => process.errorOutput += text);
  processes.push(process); return process;
}
async function ready(home, child) {
  for (let i = 0; i < 100; i++) {
    try { const session=JSON.parse(await readFile(join(work, home, 'session.json'), 'utf8')); await readFile(join(work, home, 'tray-ready.json')); return session; } catch {}
    if (child.exitCode !== null) {
      const error = await readFile(join(work, home, 'last-error.txt'), 'utf8').catch(() => 'no error log');
      throw Error('Launcher exited before ready: ' + error);
    }
    await sleep(200);
  }
  throw Error('Timed out waiting for EXE startup');
}
async function exited(child) {
  for (let i = 0; i < 300; i++) { if (child.exitCode !== null) { assert.equal(child.exitCode, 0); return; } await sleep(200); }
  throw Error('Launcher did not exit');
}
async function stop(home) {
  const helper = spawn(join(release, '深入·局域网互传.exe'), ['--stop'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, SHENRU_HOME: join(work, home) } });
  await new Promise((resolve, reject) => { helper.once('error', reject); helper.once('exit', code => code === 0 ? resolve() : reject(Error('Exit helper failed: ' + code))); });
}
try {
  const soakMs = Number(process.env.SHENRU_SOAK_MS || 30000);
  const first = launch('home-a', soakMs + 90000);
  const a = await ready('home-a', first);
  assert.equal(a.mode, 'host');
  const tray = JSON.parse(await readFile(join(work, 'home-a', 'tray-ready.json'), 'utf8'));
  assert.equal(tray.backend, 'NotifyIcon'); assert.deepEqual(tray.menu, ['打开深入·局域网互传', '退出深入·局域网互传']);
  assert.equal(tray.pid, first.pid);
  const info = await (await fetch(a.url + 'api/service-info')).json(); assert.equal(info.bootId, a.bootId); assert.equal(info.contentEncryption,1);
  const html = await readFile(join(release, '深入·局域网互传.html'), 'utf8'); assert.ok(html.includes(a.url));
  assert.match(html, /进入深入·局域网互传/);
  const profile = await fetch(a.url + 'api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: '便携包验证' }) });
  assert.equal(profile.status, 200); const cookie = profile.headers.get('set-cookie').split(';')[0]; const identity = await profile.json();
  for (const path of ['/', '/app.js','/transfer-metrics.js','/completion-notifications.js','/composer-resize.js', '/contacts.js', '/download-core.js', '/background-boot.js', '/background-ready.js', '/background-capture.js', '/brand/logo.svg', '/brand/app.ico', '/favicon.svg', '/star-scene.js', '/nebula-v2.png', '/avatars3d/character-10.png', '/share.html']) {
    const response = await fetch(new URL(path, a.url)); assert.equal(response.status, 200, path); await response.arrayBuffer();
  }
  for(const path of ['/content-crypto.js','/crypto-storage.js','/encrypted-download.js','/download-spool.js','/upload-core.js','/hash-worker.js','/vendor/noble-ciphers/chacha.js','/vendor/noble-ciphers/_arx.js','/vendor/noble-curves/ed25519.js','/vendor/noble-curves/abstract/montgomery.js','/vendor/noble-hashes/hkdf.js','/vendor/noble-hashes/hmac.js']) {
    const response=await fetch(new URL(path,a.url));assert.equal(response.status,200,path);await response.arrayBuffer();
  }
  await sleep(soakMs);
  assert.equal((await fetch(a.url + 'api/service-info')).status, 200, 'tray host survived observation interval');
  const duplicate = launch('home-a'); await exited(duplicate);
  assert.equal((await (await fetch(a.url + 'api/service-info')).json()).bootId, a.bootId);
  first.stdin.end(); await sleep(400);
  assert.equal(first.exitCode, null, 'closing the launching input must not stop the background process');
  assert.equal((await fetch(a.url + 'api/service-info')).status, 200);
  const second = launch('home-b', 60000);
  const b = await ready('home-b', second);
  assert.equal(b.mode, 'join'); assert.equal(b.bootId, a.bootId);
  await stop('home-b');
  await exited(second);
  await assert.rejects(readFile(join(work, 'home-b', 'tray-ready.json')));
  assert.equal((await fetch(a.url + 'api/service-info')).status, 200, 'joining EXE exit must not stop host');
  await stop('home-a'); await exited(first);
  await assert.rejects(fetch(a.url + 'api/service-info', { signal: AbortSignal.timeout(700) }));
  const restarted = launch('home-a', 1200);
  const c = await ready('home-a', restarted);
  assert.equal(c.mode, 'host'); assert.notEqual(c.bootId, a.bootId);
  const me = await (await fetch(c.url + 'api/state', { headers: { Cookie: cookie } })).json();
  assert.equal(me.me.id, identity.id);
  await exited(restarted);
  for (let i = 0; i < 3; i++) {
    const cycle = launch('home-a', 60000); await ready('home-a', cycle); await stop('home-a'); await exited(cycle);
  }
  for (const process of processes) assert.equal(process.errorOutput, '', 'production launcher should not report unexpected errors');
  assert.equal(first.output, '', 'background executable should not write a console UI');
  const explorerAfter = powershell("@(Get-Process -Name explorer -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) | ConvertTo-Json -Compress").trim();
  assert.equal(explorerAfter, explorerBefore, 'Explorer PID changed during production-path test');
  const desktopCrashes = powershell(`Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Diagnostics\\Microsoft.PowerShell.Diagnostics.psd1') -ErrorAction Stop; $since=[DateTimeOffset]::Parse(${quote(desktopStarted)}).LocalDateTime; try { @(Get-WinEvent -FilterHashtable @{LogName='Application';StartTime=$since;Id=1000,1001,1026} -ErrorAction Stop | Where-Object {$_.Message -match 'explorer\\.exe|深入·局域网互传\\.exe'}).Count } catch { if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') {0} else {throw} }`).trim();
  assert.equal(desktopCrashes, '0', 'new Explorer or launcher crash event during test');
  await writeFile(join(root, '.qa', 'portable-smoke-report.json'), JSON.stringify({ passed: true, work, archive,
    desktop: { startedAt: desktopStarted, endedAt: new Date().toISOString(), explorerPidStable: true, newCrashEvents: 0 },
    checks: ['ZIP has tray EXE + HTML + instructions, no separate exit helper', 'GUI PE subsystem creates no console', 'actual production EXE verifies and extracts bundled payload', 'starts HTTP host', 'updates adjacent HTML', 'all required assets served', 'same-computer duplicate joins', 'closing launcher input preserves background HTTP service', 'second EXE joins over UDP and verified HTTP', 'same EXE stop command ends only local joining instance', 'same EXE stop command gracefully stops host', 'cached EXE restart preserves identity', 'three rapid start/exit cycles', 'standard NotifyIcon initialized on production path', 'no console UI or unexpected stderr', 'Explorer PID unchanged', 'no new Explorer/launcher crash events'] }, null, 2));
  console.log('PORTABLE_EXE_SMOKE_OK');
} finally {
  for (const child of processes) if (child.exitCode === null) child.kill();
}
