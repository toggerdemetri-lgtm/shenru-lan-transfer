import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const digest = data => createHash('sha256').update(data).digest('hex');
const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const file = { name: '原图.png', size: bytes.length, sha256: digest(bytes) };

test('download saves only complete original bytes with the expected SHA-256', async () => {
  const { verifiedBlob } = await import('../public/download-core.js');
  const blob = await verifiedBlob(new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } }), file);
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
});

test('download refuses JSON errors, truncation and same-size corrupt bytes', async () => {
  const { verifiedBlob } = await import('../public/download-core.js');
  await assert.rejects(verifiedBlob(new Response('{"error":"请先填写昵称"}', { status: 401 }), file), /登录|身份|连接/);
  await assert.rejects(verifiedBlob(new Response('<html>error</html>'), file), /不一致|校验|大小/);
  await assert.rejects(verifiedBlob(new Response(bytes.subarray(0, 6)), file), /完整|大小|不一致/);
  await assert.rejects(verifiedBlob(new Response(Buffer.alloc(bytes.length)), file), /校验/);
});

test('download detects incorrect response length and bounds its memory use', async () => {
  const { verifiedBlob, BUFFERED_DOWNLOAD_LIMIT, checkDownloadResponse } = await import('../public/download-core.js');
  await assert.rejects(verifiedBlob(new Response(bytes, { headers: { 'Content-Length': '500' } }), file), /大小|不一致/);
  await assert.rejects(verifiedBlob(new Response('x'), { ...file, size: BUFFERED_DOWNLOAD_LIMIT + 1 }), /浏览器|大文件/);
  assert.throws(() => checkDownloadResponse(new Response(null, { status: 206 }), file), /完整|范围/);
});
