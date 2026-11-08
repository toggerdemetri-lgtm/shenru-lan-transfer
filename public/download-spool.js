// Store only Blob handles in IndexedDB; never collect a large file's byte arrays.
let opening;
function request(req) {return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function completed(tx) {return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error || Error('下载暂存写入失败'));});}
async function db() {
 if(!opening)opening=new Promise((resolve,reject)=>{
  if(!globalThis.indexedDB){reject(Error('浏览器不支持大文件加密下载暂存，请使用支持 IndexedDB 的浏览器'));return;}
  const r=indexedDB.open('shenru-download-cache-v1',1);
  r.onupgradeneeded=()=>{const store=r.result.createObjectStore('chunks',{keyPath:['job','index']});store.createIndex('job','job');r.result.createObjectStore('jobs',{keyPath:'id'});};
  r.onerror=()=>reject(Error('无法打开大文件下载暂存'));r.onblocked=()=>reject(Error('下载暂存被其他页面占用'));r.onsuccess=()=>resolve(r.result);
 });return opening;
}
async function remove(database,id,cutoff) {
 const tx=database.transaction(['jobs','chunks'],'readwrite'),done=completed(tx);
 const erase=()=>{
  tx.objectStore('jobs').delete(id);
  const cursor=tx.objectStore('chunks').index('job').openKeyCursor(IDBKeyRange.only(id));
  cursor.onsuccess=()=>{const c=cursor.result;if(c){tx.objectStore('chunks').delete(c.primaryKey);c.continue();}};
 };
 if(cutoff===undefined)erase();else {
  const current=tx.objectStore('jobs').get(id);
  current.onsuccess=()=>{if(current.result && current.result.touched<cutoff)erase();};
 }
 await done;
}
export async function diskBlobSink(size) {
 const database=await db();
 const oldTx=database.transaction('jobs','readonly'),oldDone=completed(oldTx),old=await request(oldTx.objectStore('jobs').getAll());await oldDone;
 const cutoff=Date.now()-600000;
 for(const job of old)if(job.touched<cutoff)await remove(database,job.id,cutoff);
 const estimate=await navigator.storage?.estimate?.().catch(()=>null);
 if(estimate?.quota && estimate.quota-(estimate.usage||0)<size*1.1)throw Error('浏览器临时空间不足，无法解密保存这个大文件');
 const id=[...crypto.getRandomValues(new Uint8Array(16))].map(x=>x.toString(16).padStart(2,'0')).join('');let index=0,bytesWritten=0,closed=false;
 const initial=database.transaction('jobs','readwrite'),initialDone=completed(initial);
 initial.objectStore('jobs').add({id,touched:Date.now(),size,nextIndex:0,bytes:0});await initialDone;
 return {
  async append(bytes) {
   if(closed)throw Error('下载暂存已结束');
   const tx=database.transaction(['jobs','chunks'],'readwrite'),done=completed(tx);let failure;
   const get=tx.objectStore('jobs').get(id);
   get.onsuccess=()=>{
    const job=get.result;
    if(!job || job.nextIndex!==index || job.bytes!==bytesWritten || bytesWritten+bytes.length>size){failure=Error('下载暂存已失效或不完整，请重新下载');tx.abort();return;}
    tx.objectStore('jobs').put({id,touched:Date.now(),size,nextIndex:index+1,bytes:bytesWritten+bytes.length});
    tx.objectStore('chunks').add({job:id,index,blob:new Blob([bytes])});
   };
   try{await done;index++;bytesWritten+=bytes.length;}catch{throw failure || Error('浏览器临时空间不足或写入失败，未保存原文件');}
  },
  async finish(type) {
   if(closed)throw Error('下载暂存已结束');
   const tx=database.transaction(['jobs','chunks'],'readonly'),done=completed(tx),parts=[];let failure,count=0,total=0;
   const fail=()=>{failure=Error('下载暂存分块不完整，未保存原文件，请重新下载');tx.abort();};
   const job=tx.objectStore('jobs').get(id);
   job.onsuccess=()=>{const value=job.result;if(!value || value.size!==size || value.nextIndex!==index || value.bytes!==size || bytesWritten!==size)fail();};
   const cursor=tx.objectStore('chunks').index('job').openCursor(IDBKeyRange.only(id));
   cursor.onsuccess=()=>{const c=cursor.result;if(c){if(c.value.index!==count || !(c.value.blob instanceof Blob)){fail();return;}count++;total+=c.value.blob.size;parts.push(c.value.blob);c.continue();}else if(count!==index || total!==size)fail();};
   try{await done;}catch(error){throw failure || error;}return new Blob(parts,{type});
  },
  async abort(){if(!closed){closed=true;await remove(database,id);}}
 };
}
