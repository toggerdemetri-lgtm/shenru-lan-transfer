import {test} from 'node:test';
import assert from 'node:assert/strict';
import {saveRenderedBackground,hasBackgroundPixels} from '../public/background-capture.js';

test('lost context cannot replace the last good image before its event is delivered',()=>{
  let rendered=false,captured=false,committed=false;
  const result=saveRenderedBackground({isContextLost:()=>true},()=>{rendered=true},()=>{captured=true;return 'bad'},()=>{committed=true});
  assert.equal(result,false);assert.equal(rendered,false);assert.equal(captured,false);assert.equal(committed,false);
});

test('loss during rendering or encoding leaves the previous cache untouched',()=>{
  for(const at of ['render','capture']){
    let lost=false,previous='last-good';
    saveRenderedBackground({isContextLost:()=>lost},()=>{if(at==='render')lost=true},()=>{if(at==='capture')lost=true;return 'bad'},image=>{previous=image;return true});
    assert.equal(previous,'last-good');
  }
});

test('only a successfully rendered nonempty frame is committed',()=>{
  let image='old';
  assert.equal(saveRenderedBackground({isContextLost:()=>false},()=>{},()=>null,value=>{image=value}),false);assert.equal(image,'old');
  assert.equal(saveRenderedBackground({isContextLost:()=>false},()=>{},()=> 'valid',value=>{image=value;return true}),true);assert.equal(image,'valid');
  assert.equal(hasBackgroundPixels(new Uint8ClampedArray(32)),false);
  assert.equal(hasBackgroundPixels(new Uint8ClampedArray([0,0,0,255,0,0,0,255])),false);
  assert.equal(hasBackgroundPixels(new Uint8ClampedArray([6,12,32,0])),false);
  assert.equal(hasBackgroundPixels(new Uint8ClampedArray([16,40,80,255])),true);
});
