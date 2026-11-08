import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectPortableSmokeArchive } from '../scripts/portable-smoke-archive.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'shenru-smoke-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist'));
  return root;
}

test('portable smoke prefers the final archive, with an intermediate fallback', async t => {
  const root = await fixture(t);
  const intermediate = join(root, 'dist', '深入·局域网互传-EXE+HTML-Windows-x64.zip');
  const final = join(root, 'dist', '深入·局域网互传-Windows.zip');
  await writeFile(intermediate, 'intermediate');
  assert.equal(await selectPortableSmokeArchive(root), intermediate);
  await writeFile(final, 'final');
  assert.equal(await selectPortableSmokeArchive(root), final);
  assert.equal(await selectPortableSmokeArchive(root, ['--archive', 'dist/深入·局域网互传-EXE+HTML-Windows-x64.zip']), intermediate);
  assert.equal(await selectPortableSmokeArchive(root, ['--archive', intermediate]), intermediate);
});

test('portable smoke fails clearly without an archive or when the explicit archive is missing', async t => {
  const root = await fixture(t);
  await assert.rejects(selectPortableSmokeArchive(root), /Portable smoke archive not found.*深入·局域网互传-Windows\.zip.*深入·局域网互传-EXE\+HTML-Windows-x64\.zip/);
  await writeFile(join(root, 'dist', '深入·局域网互传-Windows.zip'), 'final');
  await assert.rejects(selectPortableSmokeArchive(root, ['--archive', 'missing.zip']), /Portable smoke archive not found.*missing\.zip/);
  await assert.rejects(selectPortableSmokeArchive(root, ['--archive']), /Usage:/);
  await assert.rejects(selectPortableSmokeArchive(root, ['--unknown', 'archive.zip']), /Usage:/);
});
