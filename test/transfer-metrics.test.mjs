import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TransferMeter,formatDuration,formatRate,formatRemaining} from '../public/transfer-metrics.js';
import {CompletionNotifier} from '../public/completion-notifications.js';

test('meter counts active time, resets rate on resume and retains elapsed time across refresh',()=>{
 let now=0;const meter=new TransferMeter({},()=>now);meter.resume(0);
 now=1000;meter.observe(1_000_000);assert.equal(meter.stats(4_000_000).rate,1_000_000);
 assert.equal(meter.stats(4_000_000).remainingSeconds,3);meter.pause();
 now=11000;assert.equal(meter.stats(4_000_000).elapsedMs,1000);assert.equal(meter.stats(4_000_000).rate,null);
 const restored=new TransferMeter(meter.snapshot(),()=>now);restored.resume(1_000_000);
 assert.equal(restored.stats(4_000_000).rate,null);
 now=12000;restored.observe(2_000_000);assert.equal(restored.stats(4_000_000).rate,1_000_000);
 assert.equal(restored.stats(4_000_000).elapsedMs,2000);
});
test('stalls and retry rollback never produce stale or negative throughput/ETA',()=>{
 let now=0;const meter=new TransferMeter({},()=>now);meter.resume(0);
 now=1000;meter.observe(1000);now=10000;
 assert.equal(meter.stats(5000).rate,0);assert.equal(meter.stats(5000).remainingSeconds,null);
 meter.observe(400);assert.equal(meter.stats(5000).rate,null);
 now=11000;meter.observe(1400);assert.equal(meter.stats(5000).rate,1000);
 meter.observe(1400);assert.equal(meter.stats(5000).rate,1000);
});
test('formatting uses real decimal byte rates and safe finite values',()=>{
 assert.equal(formatDuration(64000),'01:04');assert.equal(formatDuration(3661000),'1:01:01');
 assert.equal(formatRate(25_600_000),'25.6 MB/s');assert.equal(formatRate(null),'—');
 assert.equal(formatRemaining(14),'约14秒');assert.equal(formatRemaining(null),'计算中');
 assert.equal(formatRate(Infinity),'—');assert.equal(formatDuration(NaN),'—');
});
const storage=()=>{const map=new Map();return{getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,String(v))};};
test('completion notices require verified ready state, permission gesture and are deduplicated across reload',async()=>{
 const prefs=storage(),session=storage(),created=[];
 class Notice {static permission='default';static async requestPermission(){this.permission='granted';return this.permission;}constructor(title,options){this.title=title;this.options=options;created.push(this);}close(){this.closed=true;}}
 const notices=new CompletionNotifier({NotificationClass:Notice,secure:true,preferences:prefs,session});
 assert.equal(notices.enabled,false);assert.equal(notices.complete({status:'uploading'},'boot:t',()=>{}),null);
 await notices.enable();assert.equal(notices.enabled,true);
 let opened=0;const tr={status:'ready',name:'原图.png',size:1024,elapsedMs:1000};
 assert.equal(notices.complete(tr,'boot:t',()=>opened++).system,true);assert.equal(created.length,1);
 created[0].onclick();assert.equal(opened,1);assert.equal(created[0].closed,true);
 assert.equal(notices.complete(tr,'boot:t',()=>{}),null);
 const reloaded=new CompletionNotifier({NotificationClass:Notice,secure:true,preferences:prefs,session});
 assert.equal(reloaded.complete(tr,'boot:t',()=>{}),null);
});
test('HTTP, denied permissions, unavailable notification backend and blocked storage retain page reminders',async()=>{
 class Denied {static permission='denied';static async requestPermission(){throw Error('must not prompt');}}
 for(const options of [{secure:false,NotificationClass:Denied},{secure:true,NotificationClass:Denied},{secure:true}]){
  const n=new CompletionNotifier(options);assert.equal(n.enabled,false);
  assert.equal(n.complete({status:'ready',name:'文件'},Math.random(),()=>{}).system,false);
 }
 const blocked={getItem(){throw Error('blocked');},setItem(){throw Error('quota');}};
 class Fails {static permission='granted';static requestPermission=async()=> 'granted';constructor(){throw Error('platform unavailable');}}
 const n=new CompletionNotifier({secure:true,NotificationClass:Fails,preferences:blocked,session:blocked});
 await n.enable();assert.equal(n.complete({status:'ready',name:'file'},'id',()=>{}).system,false);
});
