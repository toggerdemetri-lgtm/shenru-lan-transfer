// Blocking head script: restore only this tab's background canvas, never UI.
(() => {
  const key='shenru-original-background-v1',root=document.documentElement;
  const valid=state=>state&&state.version===2&&state.width===innerWidth&&state.height===innerHeight
    &&Number.isFinite(state.time)&&state.time>=0&&state.time<1e8
    &&Number.isFinite(state.x)&&Math.abs(state.x)<=1&&Number.isFinite(state.y)&&Math.abs(state.y)<=1
    &&typeof state.image==='string'&&state.image.length<3000000&&/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(state.image);
  let resume=null;
  try { const raw=sessionStorage.getItem(key);if(raw&&raw.length<3001000){const state=JSON.parse(raw);if(valid(state))resume=state;} } catch { /* Storage is optional. */ }
  let latest=resume;
  function apply(state){
    root.style.setProperty('--star-snapshot',`url("${state.image}")`);
    root.style.setProperty('--star-x',`${(state.x*16).toFixed(3)}px`);
    root.style.setProperty('--star-y',`${(state.y*11).toFixed(3)}px`);
    root.dataset.starSnapshot='ready';
  }
  if(resume)apply(resume);
  window.shenruBackdrop={resume,
    save(state){
      if(!valid(state))return false;
      latest=state;
      try{sessionStorage.setItem(key,JSON.stringify(state));return true;}catch{return false;}
    },
    recover(){if(latest){apply(latest);document.querySelector('.star-art')?.style.removeProperty('transform');}}
  };
})();
