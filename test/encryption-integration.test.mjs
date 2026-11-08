import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { fileBlocks } from '../public/upload-core.js';
import { createIdentity, sealForPeer, openFromPeer, messageContext, fileContext, bytesToHex, randomBytes } from '../public/content-crypto.js';
import { decryptedBlob } from '../public/encrypted-download.js';
import { DownloadHistory, downloadSelection, retryDownloadSelection, runDownloadQueue } from '../public/download-history.js';

async function setup(t,options={}) {
 const dir=await mkdtemp(join(tmpdir(),'shenru-encryption-'));
 const app=await createApp({dataDir:dir,host:'127.0.0.1',port:0,chunkSize:4,reserveBytes:0,quotaBytes:100000,...options});await app.start();
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function client(nickname){
  const key=createIdentity();let cookie='';
  const c={key,async call(path,body,method=body===undefined?'GET':'POST',headers={}){
   const raw=body instanceof Uint8Array;
   const r=await fetch(base+path,{method,headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':raw?'application/octet-stream':'application/json'}),...headers},body:body===undefined?undefined:raw?body:JSON.stringify(body)});
   cookie=r.headers.get('set-cookie')?.split(';')[0]||cookie;return r;
  },async json(...args){const r=await c.call(...args);const out=await r.json();assert.equal(r.ok,true,JSON.stringify(out));return out;}};
  c.user=await c.json('/api/profile',{nickname});await c.json('/api/keys',{publicKey:key.publicKey});return c;
 }
 const a=await client('加密甲'),b=await client('加密乙'),other=await client('第三人');
 const req=await a.json('/api/friends/requests',{code:b.user.code});await b.json(`/api/friends/requests/${req.id}`,{accept:true});
 const conversationId=(await a.json('/api/state')).conversations[0].id;
 return {a,b,other,dir,base,conversationId,app};
}
test('production rejects plaintext, stores opaque authenticated chat and preserves encrypted retry identity',async t=>{
 const {a,b,other,conversationId:id}=await setup(t);
 assert.equal((await a.call(`/api/conversations/${id}/messages`,{text:'不得明文',clientId:'plain'})).status,400);
 assert.equal((await a.call('/api/transfers',{conversationId:id,name:'x',size:1,clientId:'plain'})).status,400);
 assert.equal((await a.call('/api/keys',{publicKey:'0'.repeat(64)})).status,400);
 const clientId='message-one',ctx=messageContext(id,a.user.id,clientId),encrypted=sealForPeer(a.key,b.key.publicKey,ctx,'私密内容测试');
 const m=await a.json(`/api/conversations/${id}/messages`,{clientId,encrypted});
 assert.equal(m.text,undefined);assert.equal((await a.json(`/api/conversations/${id}/messages`,{clientId,encrypted})).id,m.id);
 const fresh=sealForPeer(a.key,b.key.publicKey,ctx,'私密内容测试');
 assert.equal((await a.call(`/api/conversations/${id}/messages`,{clientId,encrypted:fresh})).status,409);
 const state=await b.json('/api/state');assert.equal(JSON.stringify(state).includes('私密内容测试'),false);
 assert.equal(openFromPeer(b.key,state.conversations[0].messages[0].encrypted,ctx),'私密内容测试');
 assert.equal((await other.call(`/api/conversations/${id}/messages`,{clientId,encrypted})).status,403);
});

test('accepted encrypted messages remain idempotent after peer key rotation; unaccepted old-key messages fail closed',async t=>{
 const {a,b,conversationId:id}=await setup(t),clientId='before-rotation';
 const encrypted=sealForPeer(a.key,b.key.publicKey,messageContext(id,a.user.id,clientId),'已收到的消息');
 const first=await a.json(`/api/conversations/${id}/messages`,{clientId,encrypted});
 await b.json('/api/keys',{publicKey:createIdentity().publicKey});
 const retry=await a.call(`/api/conversations/${id}/messages`,{clientId,encrypted});assert.equal(retry.status,200);assert.equal((await retry.json()).id,first.id);
 assert.equal((await a.call(`/api/conversations/${id}/messages`,{clientId:'new-message',encrypted})).status,400);
});

test('file creation retry preserves its sealed key after key rotation and quota includes ciphertext overhead',async t=>{
 const {a,b,conversationId}=await setup(t,{quotaBytes:88});
 const data={conversationId,sender:a.user.id,name:'x.bin',size:8,type:'application/octet-stream',clientId:'creation-retry'};
 data.encryption={v:1,key:sealForPeer(a.key,b.key.publicKey,['file-key',fileContext(data)],bytesToHex(randomBytes(32)))};
 const first=await a.json('/api/transfers',data);assert.equal((await a.json('/api/state')).storage.reserved,88);
 await b.json('/api/keys',{publicKey:createIdentity().publicKey});
 assert.equal((await a.json('/api/transfers',data)).id,first.id);
 const next={...data,clientId:'quota-full',encryption:{v:1,key:sealForPeer(a.key,(await a.json('/api/state')).friends[0].encryptionKey,['file-key','new'],bytesToHex(randomBytes(32)))}};
 assert.equal((await a.call('/api/transfers',next)).status,507);
 await a.json(`/api/transfers/${first.id}`,undefined,'DELETE');assert.equal((await a.json('/api/state')).storage.reserved,0);
 assert.equal((await a.json('/api/transfers',next)).status,'uploading');
});
test('encrypted file is opaque on disk, survives resume, authenticates original download and rejects corrupt bytes',async t=>{
 const s=await setup(t),{a,b,conversationId}=s;const bytes=new TextEncoder().encode('abcdefghij');
 const key=bytesToHex(randomBytes(32)),creation={conversationId,sender:a.user.id,clientId:'encrypted-file',name:'原图.png',type:'image/png',size:bytes.length};
 const ctx=fileContext(creation),encryption={v:1,key:sealForPeer(a.key,b.key.publicKey,['file-key',ctx],key)};
 let tr=await a.json('/api/transfers',{...creation,encryption});
 const file=new Blob([bytes]);
 const first=await fileBlocks(file,4,[],{key,context:ctx,wireHashes:[]}).next();
 tr=await a.json(`/api/transfers/${tr.id}/chunks/0`,new Uint8Array(first.value.buffer),'PUT',{'X-Chunk-SHA256':first.value.hash,'X-Resume-SHA256':first.value.resumeHash});
 assert.equal(tr.offset,4);assert.equal(tr.wireSize,130);
 assert.equal((await a.call(`/api/transfers/${tr.id}/chunks/0`,new Uint8Array(first.value.buffer),'PUT',{'X-Chunk-SHA256':first.value.hash,'X-Resume-SHA256':first.value.resumeHash})).status,200);
 const wrong=fileBlocks(new Blob([new Uint8Array(bytes.length)]),4,tr.resumeHashes,{key,context:ctx,wireHashes:tr.hashes});await assert.rejects(wrong.next(),/原文件|不一致/);
 for await(const event of fileBlocks(file,4,tr.resumeHashes,{key,context:ctx,wireHashes:tr.hashes})) {
  if(event.kind==='chunk')tr=await a.json(`/api/transfers/${tr.id}/chunks/${event.index}`,new Uint8Array(event.buffer),'PUT',{'X-Chunk-SHA256':event.hash,'X-Resume-SHA256':event.resumeHash});
  if(event.kind==='complete')tr=await a.json(`/api/transfers/${tr.id}/complete`,{sha256:event.sha256,manifest:event.manifest});
 }
 assert.equal(tr.status,'ready');assert.equal(tr.size,10);assert.equal(tr.offset,10);
 const disk=await readFile(join(s.dir,'transfers',(await readdir(join(s.dir,'transfers')))[0]));assert.equal(disk.includes(Buffer.from(bytes)),false);
 const remote=(await b.json('/api/state')).conversations[0].transfers[0];
 assert.equal(openFromPeer(b.key,remote.encryption.key,['file-key',ctx]),key);
 const response=await b.call(`/api/transfers/${tr.id}/download`);assert.match(response.headers.get('content-disposition'),/shenru-encrypted/);
 const blob=await decryptedBlob(response,remote,key);assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),bytes);
 const corrupt=disk.slice();corrupt[30]^=1;await assert.rejects(decryptedBlob(new Response(corrupt),remote,key));
 assert.equal((await b.call(`/api/transfers/${tr.id}/preview`)).status,415);
 assert.equal((await s.other.call(`/api/transfers/${tr.id}/download`)).status,403);
});

test('encrypted batch saves exact originals, skips manual downloads and previews, retries corrupt files and selects new arrivals after refresh',async t=>{
 const {a,b,conversationId,dir}=await setup(t),originals=new Map(),records=new Map();
 const storage={getItem:key=>records.get(key)??null,setItem:(key,value)=>records.set(key,value)};
 let history=new DownloadHistory(storage);
 async function upload(index){
  const original=Buffer.from(`original-${index}`),secret=bytesToHex(randomBytes(32));
  const creation={conversationId,sender:a.user.id,clientId:'batch-'+index,name:'同名原件.png',type:'image/png',size:original.length};
  const context=fileContext(creation);creation.encryption={v:1,key:sealForPeer(a.key,b.key.publicKey,['file-key',context],secret)};
  let tr=await a.json('/api/transfers',creation);
  for await(const entry of fileBlocks(new Blob([original]),4,[],{key:secret,context,wireHashes:[]})){
   if(entry.kind==='chunk')tr=await a.json(`/api/transfers/${tr.id}/chunks/${entry.index}`,new Uint8Array(entry.buffer),'PUT',{'X-Chunk-SHA256':entry.hash,'X-Resume-SHA256':entry.resumeHash});
   else if(entry.kind==='complete')tr=await a.json(`/api/transfers/${tr.id}/complete`,{sha256:entry.sha256,manifest:entry.manifest});
  }
  originals.set(tr.id,original);return tr;
 }
 const first=await upload(1),second=await upload(2),third=await upload(3);
 const snapshot=await b.json('/api/state'),scope={bootId:snapshot.bootId,meId:b.user.id},conv=snapshot.conversations[0];
 async function save(tr,corrupt=false,preview=false){
  let response=await b.call(`/api/transfers/${tr.id}/download`);
  if(corrupt){const bytes=new Uint8Array(await response.arrayBuffer());bytes[bytes.length-1]^=1;response=new Response(bytes);}
  const secret=openFromPeer(b.key,tr.encryption.key,['file-key',fileContext(tr)]),blob=await decryptedBlob(response,tr,secret);
  const bytes=Buffer.from(await blob.arrayBuffer());assert.deepEqual(bytes,originals.get(tr.id));
  if(!preview){const path=join(dir,tr.id+'.saved');await writeFile(path,bytes);assert.deepEqual(await readFile(path),originals.get(tr.id));history.mark(scope,tr);}
  return 'success';
 }
 await save(first);await save(second,false,true);
 assert.deepEqual(downloadSelection(conv,scope,history).pending.map(tr=>tr.id),[second.id,third.id]);
 const result=await runDownloadQueue({items:downloadSelection(conv,scope,history).pending,download:tr=>save(tr,tr.id===second.id)});
 assert.equal(result.success,1);assert.equal(result.failed,1);assert.equal(history.has(scope,second),false);
 history=new DownloadHistory(storage);assert.deepEqual(downloadSelection(conv,scope,history).pending.map(tr=>tr.id),[second.id]);
 await runDownloadQueue({items:downloadSelection(conv,scope,history).pending,download:tr=>save(tr)});
 assert.equal(downloadSelection(conv,scope,history).pending.length,0);
 history.rememberBatch(scope,conv,[second,third]);history=new DownloadHistory(storage);
 const replayed=[];const replay=await runDownloadQueue({items:retryDownloadSelection(conv,scope,history).items,download:async tr=>{replayed.push(tr.id);return save(tr);}});
 assert.deepEqual(replayed,[second.id,third.id]);assert.equal(replay.success,2);
 const fourth=await upload(4),fresh=(await b.json('/api/state')).conversations[0];
 assert.deepEqual(downloadSelection(fresh,scope,new DownloadHistory(storage)).pending.map(tr=>tr.id),[fourth.id]);
 assert.deepEqual(retryDownloadSelection(fresh,scope,new DownloadHistory(storage)).items.map(tr=>tr.id),[second.id,third.id]);
});
