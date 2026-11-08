import {test} from 'node:test';
import assert from 'node:assert/strict';
import {atConversationEnd,conversationEndSeq,unreadConversationCount,ChatScrollIntent} from '../public/chat-attention.js';
const conversation={messages:[{id:'m1',sender:'peer',seq:1},{id:'m2',sender:'me',seq:3},{id:'m3',sender:'peer',seq:5}],transfers:[{id:'t1',sender:'peer',seq:2,status:'uploading'},{id:'t2',sender:'me',seq:4},{id:'t3',sender:'peer',seq:6,type:'image/png'}]};
test('received messages, images and files count once after read cursor while own entries are excluded',()=>{
 assert.equal(unreadConversationCount(conversation,'me',2),2);assert.equal(unreadConversationCount(conversation,'me',0),4);assert.equal(conversationEndSeq(conversation),6);
 assert.equal(unreadConversationCount(conversation,'me',conversationEndSeq(conversation)),0);
});
test('upload progress and repeated snapshots do not add notifications',()=>{
 const changed={...conversation,transfers:conversation.transfers.map(tr=>({...tr,status:'ready',offset:100}))};
 assert.equal(unreadConversationCount(changed,'me',2),2);assert.equal(unreadConversationCount(changed,'me',6),0);
});
test('bottom proximity accepts rounding and overscroll but reading above the threshold does not count as bottom',()=>{
 assert.equal(atConversationEnd({scrollHeight:1000,clientHeight:300,scrollTop:699.5}),true);
 assert.equal(atConversationEnd({scrollHeight:1000,clientHeight:300,scrollTop:720}),true);
 assert.equal(atConversationEnd({scrollHeight:1000,clientHeight:300,scrollTop:650}),false);
 assert.equal(atConversationEnd({scrollHeight:100,clientHeight:300,scrollTop:0}),true);
});
test('missing conversations and cleared sessions show no notification',()=>{
 assert.equal(unreadConversationCount(undefined,'me',0),0);assert.equal(conversationEndSeq(undefined),0);
 assert.equal(unreadConversationCount({messages:[],transfers:[]},'me',100),0);
});
test('jump and bottom-follow intent survives delayed image growth; user reading or file location interrupts follow',()=>{
 const intent=new ChatScrollIntent();assert.equal(intent.following,true);
 intent.interrupt();assert.equal(intent.following,false);assert.equal(intent.jumping,false);
 intent.jump();assert.equal(intent.following,true);assert.equal(intent.jumping,true);
 intent.arrived();assert.equal(intent.jumping,false);assert.equal(intent.following,true);
 // Images may increase scrollHeight after the first bottom was reached.
 assert.equal(atConversationEnd({scrollHeight:1200,scrollTop:700,clientHeight:300}),false);
 assert.equal(intent.following,true);
 intent.interrupt();assert.equal(intent.following,false);intent.reset();assert.equal(intent.following,true);
 intent.locate();intent.arrived();assert.equal(intent.following,false);assert.equal(intent.jumping,false);
 intent.jump();assert.equal(intent.following,true);
});
