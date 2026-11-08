import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sha256} from '../public/vendor/noble-hashes/sha2.js';
import {fileBlocks} from '../public/upload-core.js';
import {bytesToHex,randomBytes,fileContext} from '../public/content-crypto.js';
import {decryptedBlob} from '../public/encrypted-download.js';

async function fixture(size,chunkSize=4) {
 const key=bytesToHex(randomBytes(32)),bytes=new Uint8Array(size).map((_,i)=>i%251);
 const tr={conversationId:'conv',sender:'sender',clientId:'file-test',name:'原文件.bin',type:'application/octet-stream',size,chunkSize,encryption:{v:1}};
 const parts=[];for await(const e of fileBlocks(new Blob([bytes]),chunkSize,[],{key,context:fileContext(tr),wireHashes:[]})){
  if(e.kind==='chunk')parts.push(new Uint8Array(e.buffer));if(e.kind==='complete')tr.manifest=e.manifest;
 }
 const wire=new Uint8Array(await new Blob(parts).arrayBuffer());tr.sha256=bytesToHex(sha256(wire));tr.wireSize=wire.length;
 return {key,bytes,tr,wire};
}
test('encrypted empty files and both sides of chunk boundaries retain exact original bytes',async()=>{
 for(const length of [0,1,4,5,8,9]){
  const f=await fixture(length);const out=await decryptedBlob(new Response(f.wire),f.tr,f.key);assert.deepEqual(new Uint8Array(await out.arrayBuffer()),f.bytes);
 }
});
test('stream fragmentation, truncation, excess data, wrong manifest and reordering cannot save corrupt output',async()=>{
 const f=await fixture(9), stream=()=>new ReadableStream({start(c){for(const b of f.wire)c.enqueue(new Uint8Array([b]));c.close();}});
 const out=await decryptedBlob(new Response(stream()),f.tr,f.key);assert.deepEqual(new Uint8Array(await out.arrayBuffer()),f.bytes);
 await assert.rejects(decryptedBlob(new Response(f.wire.subarray(0,-1)),f.tr,f.key),/不完整|未保存/);
 await assert.rejects(decryptedBlob(new Response(new Uint8Array([...f.wire,1])),f.tr,f.key),/大小|未保存/);
 await assert.rejects(decryptedBlob(new Response(f.wire),{...f.tr,manifest:'0'.repeat(208)},f.key),/未保存/);
 const wrong=f.wire.slice();wrong.set(f.wire.subarray(44,88),0);await assert.rejects(decryptedBlob(new Response(wrong),f.tr,f.key),/未保存/);
});
test('final saved Blob must retain every byte and its original hash after temporary storage',async()=>{
 const f=await fixture(9);let cleaned=0;
 const diskSink=async()=>({async append(){},async finish(){return new Blob([f.bytes.subarray(4)]);},async abort(){cleaned++;}});
 await assert.rejects(decryptedBlob(new Response(f.wire),f.tr,f.key,()=>{},{diskSink}),/暂存|完整|大小/);assert.equal(cleaned,1);
 await assert.rejects(decryptedBlob(new Response(f.wire),f.tr,f.key,()=>{},{diskSink:async()=>({async append(){},async finish(){return new Blob([new Uint8Array(f.bytes.length)]);},async abort(){}})}),/校验|内容/);
});
test('download cancellation interrupts final Blob verification and cleans temporary storage',async()=>{
 const f=await fixture(9),controller=new AbortController();let cleaned=0;
 await assert.rejects(decryptedBlob(new Response(f.wire),f.tr,f.key,()=>{},{signal:controller.signal,onState(s){if(s.phase==='verifying')controller.abort();},diskSink:async()=>({async append(){},async finish(){return new Blob([f.bytes]);},async abort(){cleaned++;}})}),e=>e.name==='AbortError');assert.equal(cleaned,1);
});
test('cancelling after decrypted or verified bytes never returns a file or writes another block',async()=>{
 const f=await fixture(9);
 for(const phase of ['decrypting','verifying']) {
  const controller=new AbortController();let writes=0,cleaned=0;const parts=[];
  await assert.rejects(decryptedBlob(new Response(f.wire),f.tr,f.key,()=>{},{signal:controller.signal,onState(s){if(s.phase===phase && s.bytes>0)controller.abort();},diskSink:async()=>({async append(b){writes++;parts.push(new Blob([b]));},async finish(){return new Blob(parts);},async abort(){cleaned++;}})}),e=>e.name==='AbortError');
  assert.equal(cleaned,1);if(phase==='decrypting')assert.equal(writes,1);
 }
});
test('disk-backed download is sequential, cleaned after success/failure, and never falls back if storage fails',async()=>{
 const f=await fixture(64*1024*1024+1,8*1024*1024);let appended=0,cleaned=0,maxBlock=0;
 const pieces=[];const diskSink=async()=>({async append(b){maxBlock=Math.max(maxBlock,b.length);appended+=b.length;pieces.push(new Blob([b]));},async finish(){return new Blob(pieces);},async abort(){cleaned++;}});
 assert.equal((await decryptedBlob(new Response(f.wire),f.tr,f.key,()=>{},{diskSink})).size,f.tr.size);
 assert.equal(appended,f.tr.size);assert.equal(maxBlock,8*1024*1024);assert.equal(cleaned,1);
 await assert.rejects(decryptedBlob(new Response(f.wire),f.tr,f.key,()=>{},{diskSink:async()=>{throw Error('无空间');}}),/无空间/);
 let failedCleanup=0;
 await assert.rejects(decryptedBlob(new Response(f.wire),f.tr,f.key,()=>{},{diskSink:async()=>({async append(){throw Error('写入失败');},async abort(){failedCleanup++;}})}),/写入失败/);assert.equal(failedCleanup,1);
});
