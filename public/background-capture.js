// Unload can precede the queued context-loss event. Never commit a cleared GPU
// buffer over the last known-good frame, even when render() does not throw.
export function saveRenderedBackground(context,render,capture,commit) {
  try {
    if(context.isContextLost())return false;
    render();
    if(context.isContextLost())return false;
    const image=capture();
    if(!image||context.isContextLost())return false;
    return commit(image);
  } catch { return false; }
}

export function hasBackgroundPixels(pixels) {
  for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]>200&&Math.max(pixels[i],pixels[i+1],pixels[i+2])>12)return true;
  return false;
}
