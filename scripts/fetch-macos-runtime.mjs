import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = '24.22.1';
const pinned = {
  arm64: '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7',
  x64: 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035'
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function download(url, output) {
  execFileSync(process.platform === 'win32' ? 'curl.exe' : '/usr/bin/curl', ['--fail', '--location', '--noproxy', 'nodejs.org', '--retry', '3', '--connect-timeout', '20', '--max-time', '300', '--silent', '--show-error', '--output', output, url], { stdio: 'inherit', windowsHide: true });
}
const arches = process.argv.slice(2).length ? process.argv.slice(2) : ['arm64', 'x64'];
for (const arch of arches) {
  if (!pinned[arch]) throw Error('Expected arm64 or x64');
  const cache = join(root, 'runtime', `macos-${arch}`); await mkdir(cache, { recursive: true });
  const manifestPath = join(cache, 'SHASUMS256.txt');
  download(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`, manifestPath);
  const name = `node-v${version}-darwin-${arch}.tar.gz`;
  const manifest = await readFile(manifestPath, 'utf8');
  const recorded = manifest.split(/\r?\n/).find(line => line.endsWith('  ' + name))?.split(/\s+/)[0];
  if (recorded !== pinned[arch]) throw Error('Official manifest differs from the pinned release hash');
  const archive = join(cache, name);
  let existing; try { existing = sha(await readFile(archive)); } catch {}
  if (existing !== recorded) { download(`https://nodejs.org/dist/v${version}/${name}`, archive + '.part'); await rename(archive + '.part', archive); }
  if (sha(await readFile(archive)) !== recorded) throw Error('Official Node archive SHA256 mismatch');
  execFileSync('tar', ['-xzf', archive, '-C', cache, '--strip-components=1', `node-v${version}-darwin-${arch}/bin/node`, `node-v${version}-darwin-${arch}/LICENSE`], { stdio: 'inherit', windowsHide: true });
  const nodeHash = sha(await readFile(join(cache, 'bin', 'node')));
  await writeFile(join(cache, 'PROVENANCE.json'), JSON.stringify({ source: `https://nodejs.org/dist/v${version}/${name}`, manifest: `https://nodejs.org/dist/v${version}/SHASUMS256.txt`, version, arch, archiveSha256: recorded, nodeSha256: nodeHash, verifiedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`${arch}: official archive verified (${recorded}); binary ${nodeHash}`);
}
