/** The composer stays anchored at the bottom: dragging its top edge up adds height. */
export function installComposerResize({handle,textarea,composer,messages,chat,win=window,readStyle=element=>win.getComputedStyle(element)}) {
  let drag=null,manualHeight=null;
  const root=handle.ownerDocument.documentElement;
  const subscriptions=[];
  const listen=(target,type,fn)=>{target.addEventListener(type,fn);subscriptions.push(()=>target.removeEventListener(type,fn));};
  function bounds() {
    if (!composer.getBoundingClientRect().height || !chat.getBoundingClientRect().height) return null;
    const min=Number.parseFloat(readStyle(textarea).minHeight)||68;
    const current=textarea.getBoundingClientRect().height;
    const viewport=win.visualViewport;
    const visibleBottom=viewport?viewport.height+(viewport.offsetTop||0):win.innerHeight;
    const occluded=Math.max(0,chat.getBoundingClientRect().bottom-visibleBottom);
    // Keep at least 96px of the existing message viewport, including its padding.
    const max=Math.max(min,Math.min(480,current+messages.getBoundingClientRect().height-96-occluded));
    return {min,max,current};
  }
  function sync(height,limits) {
    handle.setAttribute('aria-valuemin',String(Math.round(limits.min)));
    handle.setAttribute('aria-valuemax',String(Math.round(limits.max)));
    handle.setAttribute('aria-valuenow',String(Math.round(height)));
    handle.setAttribute('aria-valuetext',`输入区高度 ${Math.round(height)} 像素`);
  }
  function setHeight(height) {
    const limits=bounds();if (!limits) return;
    manualHeight=Math.min(limits.max,Math.max(limits.min,height));
    textarea.style.height=`${manualHeight}px`;
    sync(manualHeight,limits);
  }
  function finish() {
    const active=drag;drag=null;
    composer.classList.remove('is-resizing');root.classList.remove('composer-resizing');
    if (active) {try {handle.releasePointerCapture(active.id);} catch { /* capture can be lost on cancel */ }}
  }
  function refresh() {
    const limits=bounds();if (!limits) {finish();return;}
    if (manualHeight!==null) setHeight(manualHeight);else sync(limits.current,limits);
  }
  listen(handle,'pointerdown',event=>{
    if (event.button!==0 || event.isPrimary===false || drag) return;
    const limits=bounds();if (!limits) return;
    event.preventDefault();handle.focus({preventScroll:true});
    drag={id:event.pointerId,y:event.clientY,height:limits.current};
    composer.classList.add('is-resizing');root.classList.add('composer-resizing');
    try {handle.setPointerCapture(event.pointerId);} catch { /* window listeners retain mouse fallback */ }
  });
  listen(win,'pointermove',event=>{
    if (!drag || event.pointerId!==drag.id) return;
    event.preventDefault();setHeight(drag.height+drag.y-event.clientY);
  });
  for (const type of ['pointerup','pointercancel']) listen(win,type,event=>{if(drag?.id===event.pointerId)finish();});
  listen(handle,'lostpointercapture',event=>{if(drag?.id===event.pointerId)finish();});
  listen(win,'blur',finish);listen(win,'pagehide',finish);
  listen(handle,'keydown',event=>{
    const limits=bounds();if (!limits) return;
    const step=event.shiftKey?48:24;
    const height={ArrowUp:limits.current+step,ArrowDown:limits.current-step,Home:limits.min,End:limits.max}[event.key];
    if (height===undefined) return;
    event.preventDefault();setHeight(height);
  });
  listen(win,'resize',refresh);
  if(win.visualViewport)listen(win.visualViewport,'resize',refresh);
  const observer=win.ResizeObserver?new win.ResizeObserver(refresh):null;
  observer?.observe(chat);refresh();
  return ()=>{finish();observer?.disconnect();for(const remove of subscriptions)remove();};
}
