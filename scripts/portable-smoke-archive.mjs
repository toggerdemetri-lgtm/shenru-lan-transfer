import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function selectPortableSmokeArchive(root, args = []) {
  if (args.length && (args.length !== 2 || args[0] !== '--archive' || !args[1])) {
    throw Error('Usage: node scripts/smoke-portable.mjs [--archive <zip-path>]');
  }
  const candidates = args.length
    ? [resolve(root, args[1])]
    : [join(root, 'dist', '深入·局域网互传-Windows.zip'), join(root, 'dist', '深入·局域网互传-EXE+HTML-Windows-x64.zip')];
  for (const archive of candidates) {
    try {
      if ((await stat(archive)).isFile()) return archive;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw Error(`Portable smoke archive not found. Checked: ${candidates.join(', ')}. Build the Windows package or pass --archive <zip-path>.`);
}
