import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installComposerResize} from '../public/composer-resize.js';

function fixture(){
 const emitter=()=>({events:new Map(),addEventListener(type,fn){(this.events.get(type)||this.events.set(type,new Set()).get(type)).add(fn)},removeEventListener(type,fn){this.events.get(type)?.delete(fn)},emit(type,data={}){const e={prevented:false,preventDefault(){this.prevented=true},...data};for(const fn of this.events.get(type)||[])fn(e);return e}});
 const classes=()=>({values:new Set(),add(v){this.values.add(v)},remove(v){this.values.delete(v)}});
 const doc={documentElement:{classList:classes()}};
 const handle={...emitter(),ownerDocument:doc,attrs:{},setAttribute(k,v){this.attrs[k]=v},setPointerCapture(id){this.capture=id},releasePointerCapture(id){if(this.capture===id)this.capture=null},focus(){}};
 const textarea={style:{},value:'保留草稿',getBoundingClientRect(){return{height:Number.parseFloat(this.style.height)||68}}};
 const composer={classList:classes(),getBoundingClientRect:()=>({height:textarea.getBoundingClientRect().height+100})};
 const messages={getBoundingClientRect:()=>({height:320-textarea.getBoundingClientRect().height})};
 const chat={getBoundingClientRect:()=>({height:500,bottom:600})};
 const win={...emitter(),innerHeight:600,visualViewport:{...emitter(),height:600,offsetTop:0}};
 const dispose=installComposerResize({handle,textarea,composer,messages,chat,win,readStyle:()=>({minHeight:'68px'})});
 return{handle,textarea,composer,win,doc,dispose,height:()=>textarea.getBoundingClientRect().height};
}
test('top grip grows upward, clamps both limits and releases capture without changing drafts',()=>{
 const s=fixture();s.handle.emit('pointerdown',{button:2,pointerId:1,clientY:300});assert.equal(s.handle.capture,undefined);
 s.handle.emit('pointerdown',{button:0,pointerId:1,clientY:300});assert.equal(s.handle.capture,1);
 s.win.emit('pointermove',{pointerId:2,clientY:100});assert.equal(s.height(),68);
 s.win.emit('pointermove',{pointerId:1,clientY:200});assert.equal(s.height(),168);
 s.win.emit('pointermove',{pointerId:1,clientY:-900});assert.equal(s.height(),224);
 s.win.emit('pointermove',{pointerId:1,clientY:900});assert.equal(s.height(),68);
 s.win.emit('pointerup',{pointerId:1});assert.equal(s.handle.capture,null);assert.equal(s.doc.documentElement.classList.values.size,0);
 s.win.emit('pointermove',{pointerId:1,clientY:0});assert.equal(s.height(),68);assert.equal(s.textarea.value,'保留草稿');s.dispose();
});
test('keyboard grip supports arrows and bounds without consuming chat shortcuts',()=>{
 const s=fixture();assert.equal(s.handle.emit('keydown',{key:'Enter'}).prevented,false);
 assert.equal(s.handle.emit('keydown',{key:'ArrowUp'}).prevented,true);assert.equal(s.height(),92);
 s.handle.emit('keydown',{key:'End'});assert.equal(s.height(),224);assert.equal(s.handle.attrs['aria-valuenow'],'224');
 s.handle.emit('keydown',{key:'Home'});assert.equal(s.height(),68);
 s.handle.emit('keydown',{key:'ArrowDown'});assert.equal(s.height(),68);s.dispose();
});
test('viewport shrink clamps a manually expanded composer and cancellation ends dragging',()=>{
 const s=fixture();s.handle.emit('keydown',{key:'End'});assert.equal(s.height(),224);
 s.win.visualViewport.height=450;s.win.visualViewport.emit('resize');assert.equal(s.height(),74);
 s.handle.emit('pointerdown',{button:0,pointerId:3,clientY:300});s.win.emit('pointercancel',{pointerId:3});
 assert.equal(s.handle.capture,null);assert.equal(s.composer.classList.values.size,0);
 s.dispose();assert.equal([...s.win.events.values()].reduce((n,set)=>n+set.size,0),0);
});
