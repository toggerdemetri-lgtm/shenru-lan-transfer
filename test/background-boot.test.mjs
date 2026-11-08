import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source=await readFile(new URL('../public/background-boot.js',import.meta.url),'utf8');
const record={version:2,width:1280,height:720,time:24.5,x:.2,y:-.3,image:'data:image/jpeg;base64,YWJjZA=='};
function boot(value,blocked=false){
  const values={},root={dataset:{},style:{setProperty:(key,value)=>{values[key]=value}}};
  const artwork={style:{transform:'',removeProperty(key){if(key==='transform')this.transform='';}}};
  const store=new Map(value===undefined?[]:[['shenru-original-background-v1',value]]);
  const context={innerWidth:1280,innerHeight:720,document:{documentElement:root,querySelector:selector=>selector==='.star-art'?artwork:null},sessionStorage:{getItem:key=>{if(blocked)throw Error('blocked');return store.get(key)||null},setItem:(key,value)=>{if(blocked)throw Error('quota');store.set(key,value)}}};
  context.window=context;runInNewContext(source,context);return {context,root,values,store,artwork};
}

test('refresh restores the actual frame and original animation phase before the page paints',()=>{
  const {context,root,values}=boot(JSON.stringify(record));
  assert.equal(root.dataset.starSnapshot,'ready');
  assert.equal(values['--star-snapshot'],`url("${record.image}")`);
  assert.equal(context.shenruBackdrop.resume.time,24.5);
  assert.equal(context.shenruBackdrop.resume.x,.2);
});

test('first visit, invalid data, changed viewport and blocked storage retain a safe fallback',()=>{
  for(const value of [undefined,'broken',JSON.stringify({...record,version:1}),JSON.stringify({...record,width:900}),JSON.stringify({...record,time:NaN}),JSON.stringify({...record,image:'url(javascript:bad)'})]){
    const result=boot(value);assert.equal(result.context.shenruBackdrop.resume,null);assert.equal(result.root.dataset.starSnapshot,undefined);
  }
  const result=boot(undefined,true);assert.doesNotThrow(()=>result.context.shenruBackdrop.save(record));
  assert.equal(result.context.shenruBackdrop.resume,null);
});

test('saving updates the next refresh without replacing a currently running background',()=>{
  const result=boot();result.context.shenruBackdrop.save(record);
  assert.equal(result.root.dataset.starSnapshot,undefined);
  const next=boot(result.store.get('shenru-original-background-v1'));
  assert.equal(next.context.shenruBackdrop.resume.time,record.time);
  result.artwork.style.transform='translate3d(12px,0,0)';
  result.context.shenruBackdrop.recover();assert.equal(result.root.dataset.starSnapshot,'ready');
  assert.equal(result.artwork.style.transform,'','recovery must use snapshot coordinates rather than the last live pointer offset');
});
