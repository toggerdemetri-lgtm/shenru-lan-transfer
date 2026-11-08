import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { characterFor } from '../public/avatars.js';

test('a browser identity keeps its character after nickname changes and JSON reloads', () => {
  const me = { id: 'cef29b8a-c0f9-4d69-b862-72cfec94b506', nickname: '初次进入' };
  const original = characterFor(me);
  assert.equal(characterFor({ ...me, nickname: '新的名字' }), original);
  assert.equal(characterFor(JSON.parse(JSON.stringify(me))), original);
});

test('the ten character choices resolve to ten distinct square 3D portrait images', async () => {
  const paths = new Set(Array.from({ length: 10 }, (_, i) => characterFor({ id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}` })));
  assert.equal(paths.size, 10);
  const contents = await Promise.all([...paths].map(path => readFile(new URL(`../public${path}`, import.meta.url))));
  assert.equal(new Set(contents.map(bytes => createHash('sha256').update(bytes).digest('hex'))).size, 10);
  for (const bytes of contents) {
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    assert.ok(bytes.readUInt32BE(16) >= 256);
  }
});
