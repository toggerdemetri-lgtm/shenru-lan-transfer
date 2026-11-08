// Maintenance command only. End users never need internet or a package manager.
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const staging = join(root, '.qa', 'vendor');
await mkdir(staging, { recursive: true });
const metadata = await fetch('https://registry.npmjs.org/@noble/hashes/latest').then(r => { if (!r.ok) throw Error('获取校验库失败'); return r.json(); });
const archive = Buffer.from(await fetch(metadata.dist.tarball).then(r => r.arrayBuffer()));
const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
if (metadata.dist.integrity !== integrity) throw Error('校验库下载完整性验证失败');
await writeFile(join(staging, 'hashes.tgz'), archive);
execFileSync('tar', ['-xzf', join(staging, 'hashes.tgz'), '-C', staging]);
const output = join(root, 'public', 'vendor', 'noble-hashes');
await mkdir(output, { recursive: true });
// Include the package's ESM modules and license; no CDN requests at runtime.
await cp(join(staging, 'package'), output, { recursive: true, filter: source => !/\.(ts|map)$/.test(source) && !/[\\/]src(?:[\\/]|$)/.test(source) });
await writeFile(join(output, 'PROVENANCE.json'), JSON.stringify({ package: '@noble/hashes', version: metadata.version, integrity, source: metadata.dist.tarball }, null, 2));
const runtime = join(root, 'runtime'); await mkdir(runtime, { recursive: true });
await cp(process.execPath, join(runtime, 'node.exe'));
const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`).then(r => { if (!r.ok) throw Error('获取 Node.js 许可证失败'); return r.text(); });
await writeFile(join(runtime, 'LICENSE'), license);
await writeFile(join(runtime, 'PROVENANCE.json'), JSON.stringify({ version: process.version, platform: process.platform, arch: process.arch,
  sha256: createHash('sha256').update(await readFile(join(runtime, 'node.exe'))).digest('hex'), source: 'Bundled local Node.js runtime' }, null, 2));
console.log(`Vendored @noble/hashes ${metadata.version}; offline Node ${process.version} (${process.arch})`);
