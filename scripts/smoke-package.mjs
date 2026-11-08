import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const name = `深入·局域网互传-${version}-Windows-x64`;
await mkdir(join(root, '.qa'), { recursive: true });
const target = await mkdtemp(join(root, '.qa', 'unpacked-'));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${quote(join(root, 'dist', `${name}.zip`))}, ${quote(target)})`]);
const unpacked = join(target, name);
for (const entry of (await readFile(join(unpacked, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n')) {
  const [expected, file] = entry.split('  ');
  const actual = createHash('sha256').update(await readFile(join(unpacked, file))).digest('hex');
  if (actual !== expected) throw Error(`离线包完整性错误：${file}`);
}
const code = `
import { createApp } from ${JSON.stringify(pathToFileURL(join(unpacked, 'server.mjs')).href)};
const app = await createApp({port:0,host:'127.0.0.1',dataDir:${JSON.stringify(join(target, 'smoke-data'))}});
try {
 await app.start(); const base='http://127.0.0.1:'+app.server.address().port;
 for(const path of ['/','/app.js','/transfer-metrics.js','/completion-notifications.js','/composer-resize.js','/avatars.js','/avatars/index.html','/avatars/gallery.css',...Array.from({length:10},(_,i)=>'/avatars3d/character-'+String(i+1).padStart(2,'0')+'.png'),'/style.css','/glass.css','/universe.css','/universe.js','/star-scene.js','/nebula-v2.png','/vendor/three/three.module.min.js','/vendor/three/three.core.min.js','/hash-worker.js','/vendor/noble-hashes/sha2.js']) {
  const res=await fetch(base+path); if(res.status!==200) throw Error(path+': '+res.status); await res.arrayBuffer();
 }
 const profile=await fetch(base+'/api/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nickname:'离线运行验证'})});
 if(profile.status!==200 || !profile.headers.get('set-cookie')) throw Error('身份接口验证失败');
 console.log('OFFLINE_PACKAGE_SMOKE_OK');
} finally { await app.close(); }`;
const output = execFileSync(join(unpacked, 'runtime', 'node.exe'), ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20000 });
if (!output.includes('OFFLINE_PACKAGE_SMOKE_OK')) throw Error('离线启动验证未完成');
await writeFile(join(root, '.qa', 'package-report.json'), JSON.stringify({ passed: true, archive: `dist/${name}.zip`, checks: ['ZIP extraction', 'every file SHA256', 'bundled Node executable', 'HTTP start', 'local HTML/CSS/JS/worker/hash library', 'identity cookie'] }, null, 2));
console.log(output.trim());
