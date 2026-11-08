import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, sealForPeer, openFromPeer, sealBlock, openBlock, resumeFingerprint, sealManifest, openManifest } from '../public/content-crypto.js';

test('peer envelopes decrypt at both endpoints, never at an unrelated key, bind context and reject tampering', () => {
 const a=createIdentity(), b=createIdentity(), c=createIdentity(), context=['message','conversation','alice','id'];
 const box=sealForPeer(a,b.publicKey,context,'你好，原文不应上传');
 assert.equal(openFromPeer(b,box,context),'你好，原文不应上传');
 assert.equal(openFromPeer(a,box,context),'你好，原文不应上传');
 assert.throws(()=>openFromPeer(c,box,context));
 assert.throws(()=>openFromPeer(b,box,[...context,'different']));
 assert.throws(()=>openFromPeer(b,{...box,ciphertext:'00'+box.ciphertext.slice(2)},context));
 assert.notDeepEqual(box,sealForPeer(a,b.publicKey,context,'你好，原文不应上传'));
});
test('file blocks use fresh nonces, bind index/metadata, and resume fingerprints detect same-size wrong content',()=>{
 const key=createIdentity().secretKey, bytes=new TextEncoder().encode('原图字节'), ctx=['file','id',bytes.length];
 const first=sealBlock(key,ctx,0,bytes), second=sealBlock(key,ctx,0,bytes);
 assert.equal(first.length,bytes.length+40); assert.notDeepEqual(first,second);
 assert.deepEqual(openBlock(key,ctx,0,first),bytes);
 assert.throws(()=>openBlock(key,ctx,1,first));assert.throws(()=>openBlock(key,['other'],0,first));
 const corrupt=first.slice();corrupt[corrupt.length-1]^=1;assert.throws(()=>openBlock(key,ctx,0,corrupt));
 assert.equal(resumeFingerprint(key,ctx,0,bytes),resumeFingerprint(key,ctx,0,bytes));
 assert.notEqual(resumeFingerprint(key,ctx,0,bytes),resumeFingerprint(key,ctx,0,new Uint8Array(bytes.length)));
 const hash='a'.repeat(64), manifest=sealManifest(key,ctx,hash);
 assert.equal(openManifest(key,ctx,manifest),hash);assert.throws(()=>openManifest(key,['other'],manifest));
});
