import { cp, mkdir, mkdtemp, readFile, writeFile, readdir, stat, rename } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const name = `深入·局域网互传-${version}-Windows-x64`;
await mkdir(join(root, 'dist'), { recursive: true });
await mkdir(join(root, '.qa'), { recursive: true });
const staging = await mkdtemp(join(root, '.qa', 'package-'));
const out = join(staging, name);
await mkdir(out, { recursive: true });
for (const item of ['server.mjs', 'lib', 'public', 'start.cmd', 'config.cmd', 'README.md', 'package.json']) await cp(join(root, item), join(out, item), { recursive: true });
await mkdir(join(out, 'runtime'));
for (const item of ['node.exe', 'LICENSE', 'PROVENANCE.json']) await cp(join(root, 'runtime', item), join(out, 'runtime', item));
const runtime = JSON.parse(await readFile(join(out, 'runtime', 'PROVENANCE.json'), 'utf8'));
const actual = createHash('sha256').update(await readFile(join(out, 'runtime', 'node.exe'))).digest('hex');
if (runtime.sha256 !== actual) throw Error('运行时校验失败');
const paths = [];
async function walk(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const file = join(dir, entry.name); if (entry.isDirectory()) await walk(file); else paths.push(file); } }
await walk(out);
const manifest = [];
for (const file of paths.sort()) manifest.push(`${createHash('sha256').update(await readFile(file)).digest('hex')}  ${file.slice(out.length + 1).replaceAll('\\', '/')}`);
await writeFile(join(out, 'SHA256SUMS.txt'), manifest.join('\n') + '\n');
const archive = join(root, 'dist', `${name}.zip`);
const pendingArchive = join(root, 'dist', `${name}-${Date.now()}.zip`);
if (process.platform === 'win32') {
  // Literal, fixed workspace paths; native PowerShell handles the archive end-to-end.
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${quote(staging)}, ${quote(pendingArchive)}, [System.IO.Compression.CompressionLevel]::Optimal, $false)`], { stdio: 'inherit' });
} else throw Error('Windows 离线包请在 Windows 环境生成');
await rename(pendingArchive, archive);
console.log(`已生成 ${archive} (${((await stat(archive)).size / 1e6).toFixed(1)} MB)`);
