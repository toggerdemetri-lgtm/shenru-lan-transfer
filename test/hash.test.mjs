import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileBlocks } from '../public/upload-core.js';
const digest = data => createHash('sha256').update(data).digest('hex');
test('worker hashing matches Node SHA-256 and skips only verified resume blocks', async () => {
  const data = Buffer.from('abcdefghij'); const events = [];
  for await (const event of fileBlocks(new Blob([data]), 4, [digest('abcd')])) events.push(event);
  assert.equal(events[0].kind, 'verified');
  assert.deepEqual(events.filter(x => x.kind === 'chunk').map(x => x.index), [1, 2]);
  assert.equal(events.at(-1).sha256, digest(data));
  assert.equal(events[1].hash, digest('efgh'));
});
test('wrong selected file is rejected before any remaining block is sent', async () => {
  let sent = 0;
  await assert.rejects(async () => {
    for await (const event of fileBlocks(new Blob(['xxxxefghij']), 4, [digest('abcd')])) if (event.kind === 'chunk') sent++;
  }, /不一致/);
  assert.equal(sent, 0);
});
test('empty files have a real SHA-256 and no upload blocks', async () => {
  const events = [];
  for await (const event of fileBlocks(new Blob([]), 4, [])) events.push(event);
  assert.deepEqual(events, [{ kind: 'complete', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }]);
});
