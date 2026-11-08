import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DownloadHistory, downloadSelection, retryDownloadSelection, runDownloadQueue,downloadControlState} from '../public/download-history.js';
const scope={bootId:'space-a',meId:'me'};
const file=(id,extra={})=>({id,conversationId:'conv',sender:'peer',status:'ready',size:10,sha256:'hash-'+id,seq:Number(id)||0,...extra});
const store=()=>{const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};};
test('downloaded primary disables while redownload and list icons stay enabled; busy and unavailable block every action',()=>{
 assert.deepEqual(downloadControlState({downloaded:true,kind:'primary'}),{label:'已下载',disabled:true,hidden:false});
 assert.deepEqual(downloadControlState({downloaded:true,kind:'again'}),{label:'重新下载',disabled:false,hidden:false});
 assert.equal(downloadControlState({downloaded:true,kind:'list'}).disabled,false);
 assert.equal(downloadControlState({downloaded:false,kind:'again'}).hidden,true);
 for(const kind of ['primary','again','list']){
  assert.equal(downloadControlState({downloaded:true,kind,busy:true}).disabled,true);
  assert.equal(downloadControlState({downloaded:false,kind,ready:false}).disabled,true);
 }
});
test('threshold counts received non-cancelled items, only ready unrecorded files are selected',()=>{
 const history=new DownloadHistory(store());const conv={id:'conv',peerId:'peer',transfers:[file('1'),file('2')]};
 assert.equal(downloadSelection(conv,scope,history).visible,false);
 conv.transfers.push(file('3',{status:'uploading'}),file('4',{sender:'me'}),file('5',{status:'cancelled'}));
 let selection=downloadSelection(conv,scope,history);assert.equal(selection.visible,true);assert.deepEqual(selection.pending.map(f=>f.id),['1','2']);assert.equal(selection.waiting,1);
 history.mark(scope,file('1'));assert.deepEqual(downloadSelection(conv,scope,history).pending.map(f=>f.id),['2']);
});
test('manual and batch history survives refresh and is isolated by account, space, conversation and transfer content',()=>{
 const storage=store(),history=new DownloadHistory(storage),tr=file('1');assert.equal(history.has(scope,tr),false);history.mark(scope,tr);
 const refreshed=new DownloadHistory(storage);assert.equal(refreshed.has(scope,tr),true);
 for(const other of [{...scope,meId:'other'},{...scope,bootId:'space-b'}])assert.equal(refreshed.has(other,tr),false);
 for(const other of [file('2'),file('1',{conversationId:'other'}),file('1',{sha256:'changed'}),file('1',{size:11})])assert.equal(refreshed.has(scope,other),false);
});
test('other tabs see per-file writes and blocked storage keeps in-memory records',()=>{
 const storage=store(),a=new DownloadHistory(storage),b=new DownloadHistory(storage);a.mark(scope,file('1'));b.mark(scope,file('2'));assert.equal(a.has(scope,file('2')),true);assert.equal(b.has(scope,file('1')),true);
 const broken=new DownloadHistory({getItem(){throw Error('blocked')},setItem(){throw Error('quota')}});broken.mark(scope,file('1'));assert.equal(broken.has(scope,file('1')),true);assert.equal(broken.persistent,false);
});
test('queue is sequential, keeps failures pending, and freezes newly arriving files',async()=>{
 const source=[file('1'),file('2'),file('3')],started=[],history=new DownloadHistory(store());let active=0,peak=0;
 const result=await runDownloadQueue({items:source,async download(tr){started.push(tr.id);active++;peak=Math.max(peak,active);await Promise.resolve();active--;if(tr.id==='1')source.push(file('4'));if(tr.id==='2')return 'error';history.mark(scope,tr);return 'success';}});
 assert.deepEqual(started,['1','2','3']);assert.equal(peak,1);assert.equal(result.success,2);assert.equal(result.failed,1);assert.equal(history.has(scope,file('2')),false);
});
test('cancelling stops pending files; thrown download errors remain retryable',async()=>{
 const controller=new AbortController(),started=[];
 const result=await runDownloadQueue({items:[file('1'),file('2')],signal:controller.signal,async download(tr){started.push(tr.id);controller.abort();return 'cancelled';}});
 assert.deepEqual(started,['1']);assert.equal(result.cancelled,true);
 const failed=await runDownloadQueue({items:[file('1')],async download(){throw Error('integrity mismatch')}});assert.equal(failed.failed,1);
});

test('last batch can be explicitly replayed after handoff records and refresh without including newly arriving files',()=>{
 const storage=store(),history=new DownloadHistory(storage),items=[file('1'),file('2')];
 const conv={id:'conv',peerId:'peer',transfers:[...items,file('3')]};
 history.rememberBatch(scope,conv,items);for(const tr of items)history.mark(scope,tr);
 const reloaded=new DownloadHistory(storage);
 assert.deepEqual(reloaded.lastBatch(scope,conv).map(tr=>tr.id),['1','2']);
 assert.deepEqual(downloadSelection(conv,scope,reloaded).pending.map(tr=>tr.id),['3']);
 assert.equal(reloaded.lastBatch({...scope,meId:'other'},conv).length,0);
 assert.equal(reloaded.lastBatch({...scope,bootId:'other'},conv).length,0);
 assert.equal(reloaded.lastBatch(scope,{...conv,id:'other'}).length,0);
 assert.deepEqual(reloaded.lastBatch(scope,{...conv,transfers:[file('1',{sha256:'changed'}),file('2',{status:'cancelled'}),file('3')]}),[]);
});
test('batch replay remains available in memory when storage is blocked and ignores malformed saved batches',()=>{
 const blocked=new DownloadHistory({getItem(){throw Error('blocked')},setItem(){throw Error('blocked')}}),conv={id:'conv',peerId:'peer',transfers:[file('1')]};
 blocked.rememberBatch(scope,conv,conv.transfers);assert.equal(blocked.lastBatch(scope,conv).length,1);
 for(const value of ['not json','{}','null','[1,null,{}]']){
  const corrupt=new DownloadHistory({getItem(){return value}});assert.deepEqual(corrupt.lastBatch(scope,conv),[]);
 }
});

test('previous version handoff records remain recoverable without replaying newly received unrecorded files',()=>{
 const history=new DownloadHistory(store()),conv={id:'conv',peerId:'peer',transfers:[file('1'),file('2'),file('3')]};
 history.mark(scope,file('1'));history.mark(scope,file('2'));
 assert.deepEqual(retryDownloadSelection(conv,scope,history).items.map(tr=>tr.id),['1','2']);
 assert.equal(retryDownloadSelection(conv,scope,history).legacy,true);
 history.rememberBatch(scope,conv,[file('2')]);
 assert.deepEqual(retryDownloadSelection(conv,scope,history).items.map(tr=>tr.id),['2']);
 assert.equal(retryDownloadSelection(conv,scope,history).legacy,false);
});

test('quota failure cannot replace the current in-memory retry batch with an older readable saved batch',()=>{
 const backing=store();let rejectWrites=false;
 const storage={getItem:key=>backing.getItem(key),setItem(key,value){if(rejectWrites)throw Error('quota exceeded');backing.setItem(key,value);}};
 const history=new DownloadHistory(storage),conv={id:'conv',peerId:'peer',transfers:[file('1'),file('2'),file('3')]};
 history.rememberBatch(scope,conv,[file('1')]);rejectWrites=true;history.rememberBatch(scope,conv,[file('2'),file('3')]);
 assert.deepEqual(history.lastBatch(scope,conv).map(tr=>tr.id),['2','3']);assert.equal(history.persistent,false);
});
