// Per-file keys let multiple tabs add records without overwriting each other.
export class DownloadHistory {
  constructor(storage) { this.storage=storage;this.memory=new Set();this.batches=new Map();this.volatileBatches=new Set();this.persistent=!!storage; }
  key(scope,tr) { return 'shenru-downloaded:v1:'+JSON.stringify([scope.bootId,scope.meId,tr.conversationId,tr.id,tr.size,tr.sha256]); }
  has(scope,tr) {
    const key=this.key(scope,tr);
    try { if(this.storage?.getItem(key)==='1')return true; } catch {this.persistent=false;}
    return this.memory.has(key);
  }
  mark(scope,tr) {
    const key=this.key(scope,tr);this.memory.add(key);
    try { if(this.storage)this.storage.setItem(key,'1');else this.persistent=false; } catch {this.persistent=false;}
  }
  batchKey(scope,conversation) {return 'shenru-download-batch:v1:'+JSON.stringify([scope.bootId,scope.meId,conversation.id]);}
  rememberBatch(scope,conversation,items) {
    const key=this.batchKey(scope,conversation),tokens=items.map(tr=>this.key(scope,tr));this.batches.set(key,tokens);
    try {if(this.storage){this.storage.setItem(key,JSON.stringify(tokens));this.volatileBatches.delete(key);}else {this.persistent=false;this.volatileBatches.add(key);}}catch{this.persistent=false;this.volatileBatches.add(key);}
  }
  lastBatch(scope,conversation) {
    if(!conversation)return [];
    const key=this.batchKey(scope,conversation);let tokens=this.batches.get(key)||[];
    try {const saved=this.volatileBatches.has(key)?null:this.storage?.getItem(key);if(saved!==null && saved!==undefined){const parsed=JSON.parse(saved);tokens=Array.isArray(parsed)?parsed.filter(value=>typeof value==='string'):[];}}catch{this.persistent=false;}
    const lookup=new Set(tokens);
    return conversation.transfers.filter(tr=>tr.sender===conversation.peerId&&tr.status==='ready'&&lookup.has(this.key(scope,tr))).sort((a,b)=>(a.seq||0)-(b.seq||0));
  }
}
export function downloadSelection(conversation,scope,history) {
  const incoming=(conversation?.transfers||[]).filter(tr=>tr.sender===conversation.peerId && tr.status!=='cancelled');
  const pending=incoming.filter(tr=>tr.status==='ready' && !history.has(scope,tr)).sort((a,b)=>(a.seq||0)-(b.seq||0));
  return {visible:incoming.length>=3,pending,waiting:incoming.filter(tr=>tr.status!=='ready').length};
}
export function retryDownloadSelection(conversation,scope,history) {
  const batch=history.lastBatch(scope,conversation);
  if(batch.length)return {items:batch,legacy:false};
  const items=(conversation?.transfers||[]).filter(tr=>tr.sender===conversation.peerId && tr.status==='ready' && history.has(scope,tr)).sort((a,b)=>(a.seq||0)-(b.seq||0));
  return {items,legacy:true};
}
export function downloadControlState({downloaded=false,busy=false,ready=true,kind='primary'}={}) {
  return {label:kind==='primary'?(downloaded?'已下载':'下载原文件'):(downloaded?'重新下载':'下载原文件'),disabled:busy||!ready||(kind==='primary'&&downloaded),hidden:kind==='again'&&!downloaded};
}
export async function runDownloadQueue({items,download,signal,onProgress=()=>{}}) {
  const queue=[...items],result={success:0,failed:0,cancelled:false,total:queue.length};
  for(let index=0;index<queue.length;index++) {
    if(signal?.aborted){result.cancelled=true;break;}
    onProgress({index:index+1,total:queue.length,...result});
    let outcome;
    try {outcome=await download(queue[index]);}catch{outcome='error';}
    if(outcome==='success')result.success++;
    else if(outcome==='cancelled'||signal?.aborted){result.cancelled=true;break;}
    else result.failed++;
  }
  return result;
}
