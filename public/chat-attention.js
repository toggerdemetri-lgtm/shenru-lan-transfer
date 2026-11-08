export function atConversationEnd({scrollHeight,scrollTop,clientHeight},threshold=24) {
  return scrollHeight-clientHeight-scrollTop<=threshold;
}
export function conversationEndSeq(conversation) {
  return [...(conversation?.messages||[]),...(conversation?.transfers||[])].reduce((end,item)=>Math.max(end,item.seq||0),0);
}
export function unreadConversationCount(conversation,meId,readThrough=0) {
  return [...(conversation?.messages||[]),...(conversation?.transfers||[])].filter(item=>item.sender!==meId && item.seq>readThrough).length;
}
export class ChatScrollIntent {
  constructor(){this.reset();}
  reset(){this.following=true;this.jumping=false;this.locating=false;}
  jump(){this.following=true;this.jumping=true;this.locating=false;}
  arrived(){this.following=!this.locating;this.jumping=false;}
  interrupt(){this.following=false;this.jumping=false;this.locating=false;}
  locate(){this.interrupt();this.locating=true;}
}
