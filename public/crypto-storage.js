import { createIdentity } from './content-crypto.js';

let database;
function db() {
 if(!database)database=new Promise((resolve,reject)=>{
  if(!globalThis.indexedDB){reject(Error('浏览器存储不可用，无法安全保存加密密钥'));return;}
  const req=indexedDB.open('shenru-content-keys-v1',1);
  req.onupgradeneeded=()=>req.result.createObjectStore('identities');
  req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(Error('无法打开浏览器加密密钥存储'));
  req.onblocked=()=>reject(Error('密钥存储被其他页面占用，请关闭旧页面后重试'));
 });return database;
}
// One read/write transaction elects a single key even when tabs open together.
export async function loadIdentity(userId) {
 const database=await db();
 return new Promise((resolve,reject)=>{
  const tx=database.transaction('identities','readwrite'),store=tx.objectStore('identities');let identity;
  const request=store.get(userId);
  request.onsuccess=()=>{identity=request.result;if(!identity){identity=createIdentity();store.add(identity,userId);}};
  tx.oncomplete=()=>resolve(identity);tx.onabort=tx.onerror=()=>reject(Error('无法保存加密密钥，已停止发送以避免明文传输'));
 });
}
