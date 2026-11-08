/* finesse · background=TinyStar66 · motion=ambient-30fps · self-hosted */
// Adapted from the user's local TinyStar66 page for self-contained LAN use.
import * as THREE from './vendor/three/three.module.min.js';
import { createBackgroundHandoff } from './background-ready.js';
import { saveRenderedBackground, hasBackgroundPixels } from './background-capture.js';

const noise = `
  float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123); }
  float noise(vec2 p) {
    vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
  }
  float fbm(vec2 p) { float f=0.0,a=0.5; for(int i=0;i<5;i++){ f+=a*noise(p); p=mat2(1.6,-1.2,1.2,1.6)*p+2.7; a*=0.5; } return f; }
`;

const terrainVertex = `
  uniform float uTime;
  varying vec3 vWorld;
  ${noise}
  void main() {
    vec3 p=position;
    float n=fbm(p.xz*0.12);
    float left=exp(-pow((p.x+24.0)/17.0,2.0))*6.8;
    float right=exp(-pow((p.x-36.0)/17.0,2.0))*10.0;
    float ridge=exp(-pow((p.z+38.0)/12.0,2.0))*(2.5+5.0*fbm(p.xz*0.16));
    p.y=(left+right)*(0.50+n*0.9)+ridge+n*1.1;
    p.y+=sin(p.x*0.25+p.z*0.12+uTime*0.85)*0.65;
    p.y+=cos(p.x*0.13-p.z*0.18-uTime*0.55)*0.2;
    vWorld=p;
    gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
  }
`;

export function createStarScene(container, hero) {
  const artwork=container.closest('.star-art');
  const backdrop=window.shenruBackdrop;
  const resume=backdrop?.resume;
  const handoff=createBackgroundHandoff(artwork);
  const fallback={setMotion(){},setVisible(){},dispose(){}};
  const canvas=document.createElement('canvas');
  let renderer;
  try {
    const context=canvas.getContext('webgl2',{alpha:true,antialias:true,powerPreference:'low-power'});
    if(!context) { artwork.dataset.renderer='static'; return fallback; }
    renderer=new THREE.WebGLRenderer({canvas,context,alpha:true,antialias:true});
  } catch { artwork.dataset.renderer='static'; return fallback; }
  renderer.setClearColor(0x060c20,0);
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  container.append(canvas);
  const scene=new THREE.Scene();
  const camera=new THREE.PerspectiveCamera(48,1,0.1,250);
  const mobile=matchMedia('(max-width:700px)');
  const fine=matchMedia('(hover:hover) and (pointer:fine)');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const clock={value:resume?.time??7.5};
  const pointer=new THREE.Vector2(resume?.x??0,resume?.y??0);
  const smoothPointer=new THREE.Vector2(resume?.x??0,resume?.y??0);
  const resolution={value:new THREE.Vector2(1,1)};
  const uniforms={uTime:clock,uPointer:{value:smoothPointer},uResolution:resolution,uMap:{value:null},uLoaded:{value:0},uImageAspect:{value:1.7778}};
  const backgroundMaterial=new THREE.ShaderMaterial({
    uniforms,depthWrite:false,depthTest:false,
    vertexShader:`varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,1.,1.);}`,
    fragmentShader:`
      uniform sampler2D uMap;
      uniform float uLoaded,uTime,uImageAspect;
      uniform vec2 uPointer,uResolution;
      varying vec2 vUv;
      ${noise}
      void main(){
        vec2 uv=vUv, imageUv=uv;
        float aspect=uResolution.x/uResolution.y;
        if(aspect>uImageAspect) imageUv.y=(uv.y-.5)*uImageAspect/aspect+.5;
        else imageUv.x=(uv.x-.5)*aspect/uImageAspect+.5;
        imageUv=(imageUv-.5)*.94+.5;
        imageUv+=uPointer*vec2(-.010,.007);
        imageUv+=vec2(sin(uv.y*5.0+uTime*.2),cos(uv.x*4.0+uTime*.16))*.018;
        vec2 fogUv=uv*vec2(4.0,3.0)+vec2(uTime*.035,-uTime*.018);
        float fog=noise(fogUv)*.65+noise(fogUv*2.1)*.25+noise(fogUv*4.3)*.1;
        vec3 color;
        if(uLoaded>.5) color=texture2D(uMap,clamp(imageUv,.005,.995)).rgb;
        else {
          color=mix(vec3(.015,.025,.09),vec3(.035,.22,.38),smoothstep(.26,.7,fog));
          color+=vec3(.07,.025,.12)*noise(uv*4.0+4.0);
        }
        color*=.81+fog*.25;
        float light=exp(-pow((uv.x-.56)/.25,2.0)-pow((uv.y-.36)/.22,2.0));
        color+=vec3(.02,.08,.13)*light;
        float stream=0.;
        for(int i=0;i<6;i++){
          float fi=float(i);
          float curve=.515+sin(uv.x*2.8+uTime*.16)*.065+fi*.013+pow((uv.x-.4)*.5,2.0);
          stream+=exp(-pow((uv.y-curve)/.0014,2.0))*exp(-pow((uv.x-.56)/.21,2.0))*(.6-fi*.06);
        }
        color+=vec3(.09,.06,.18)*stream;
        float vignette=1.-.26*pow(length((uv-.5)*vec2(1.0,.8)),1.3);
        color*=vignette;
        gl_FragColor=vec4(color,1.);
      }
    `,
  });
  const sky=new THREE.Mesh(new THREE.PlaneGeometry(2,2),backgroundMaterial);
  sky.frustumCulled=false; sky.renderOrder=-10; scene.add(sky);
  let disposed=false,failed=false,enabled=false,visible=true,frame=0,previous=0;
  let texture;
  new THREE.TextureLoader().load(new URL('./nebula-v2.png', import.meta.url).href,loaded=>{
    if(disposed){loaded.dispose();return;}
    texture=loaded;
    uniforms.uMap.value=loaded;
    uniforms.uImageAspect.value=loaded.image.width/loaded.image.height;
    uniforms.uLoaded.value=1;
    handoff.textureReady();
    draw(); saveFrame(); schedule();
  },undefined,()=>{ fail(); });

  const geometry=new THREE.PlaneGeometry(140,150,mobile.matches?70:120,mobile.matches?70:110);
  geometry.rotateX(-Math.PI/2); geometry.translate(0,0,-45);
  const landUniforms={uTime:clock};
  const landMaterial=new THREE.ShaderMaterial({
    uniforms:landUniforms,vertexShader:terrainVertex,
    fragmentShader:`varying vec3 vWorld; void main(){
      float light=exp(-pow((vWorld.x-5.)/24.,2.)-pow((vWorld.z+40.)/30.,2.));
      vec3 color=mix(vec3(.002,.008,.021),vec3(.012,.055,.12),light);
      float alpha=1.-smoothstep(75.,120.,-vWorld.z);
      gl_FragColor=vec4(color,alpha*.97);
    }`,transparent:true,depthWrite:true,
  });
  scene.add(new THREE.Mesh(geometry,landMaterial));
  const lines=geometry.clone();
  const nx=geometry.parameters.widthSegments,nz=geometry.parameters.heightSegments;
  const indices=[];
  for(let j=0;j<=nz;j++) for(let i=0;i<=nx;i++){
    const a=j*(nx+1)+i;
    if(i<nx)indices.push(a,a+1);
    if(j<nz)indices.push(a,a+nx+1);
  }
  lines.setIndex(indices);
  const lineMaterial=new THREE.ShaderMaterial({
    uniforms:landUniforms,vertexShader:terrainVertex,transparent:true,depthWrite:false,
    fragmentShader:`uniform float uTime; varying vec3 vWorld; void main(){
      float light=exp(-pow((vWorld.x-5.)/25.,2.)-pow((vWorld.z+37.)/30.,2.));
      float far=1.-smoothstep(65.,120.,-vWorld.z);
      float near=1.-smoothstep(-2.,20.,vWorld.z);
      float wave=pow(.5+.5*sin(vWorld.z*.16+uTime*1.9),24.0)*light;
      vec3 blue=mix(vec3(.018,.16,.28),vec3(.16,.65,.95),light);
      blue+=vec3(.02,.12,.22)*wave;
      gl_FragColor=vec4(blue,(.16+light*.55+wave*.1)*far*near);
    }`,
  });
  const grid=new THREE.LineSegments(lines,lineMaterial);grid.renderOrder=1;scene.add(grid);
  const count=mobile.matches?170:340;
  const positions=new Float32Array(count*3),seeds=new Float32Array(count);
  for(let i=0;i<count;i++){
    const a=Math.sin(i*127.1+81.7)*43758.54;
    const b=Math.sin(i*269.5+3.8)*52733.12;
    const seed=a-Math.floor(a);
    positions.set([seed*2.-1.,(b-Math.floor(b))*2.-1.,0],i*3);
    seeds[i]=Math.abs(Math.sin(i*32.17));
  }
  const starGeometry=new THREE.BufferGeometry();
  starGeometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
  starGeometry.setAttribute('seed',new THREE.BufferAttribute(seeds,1));
  const starUniforms={uTime:clock,uPointer:{value:smoothPointer},uPixelRatio:{value:1}};
  const starMaterial=new THREE.ShaderMaterial({
    uniforms:starUniforms,transparent:true,depthTest:false,depthWrite:false,blending:THREE.AdditiveBlending,
    vertexShader:`attribute float seed; uniform float uTime,uPixelRatio; uniform vec2 uPointer; varying float vSeed; varying float vFade; void main(){
      vSeed=seed; vec2 p=position.xy;
      p.x=mod(p.x+1.+uTime*.008*(.3+seed),2.)-1.;
      p.y=mod(p.y+1.+uTime*.0018*(.3+seed),2.)-1.;
      p+=uPointer*vec2(.018,-.018)*(.2+seed);
      gl_Position=vec4(p,.8,1.);
      gl_PointSize=(seed>.975?5.5:1.+seed*1.3)*uPixelRatio;
      vFade=(.4+.25*sin(uTime*.9+seed*72.))*smoothstep(-.95,-.15,p.y);
    }`,
    fragmentShader:`varying float vSeed,vFade; void main(){float r=length(gl_PointCoord-.5)*2.; float a=pow(max(0.,1.-r),1.8)*vFade; vec3 c=mix(vec3(.5,.7,1.),vec3(.85,.68,1.),vSeed); gl_FragColor=vec4(c,a);}`,
  });
  const stars=new THREE.Points(starGeometry,starMaterial); stars.frustumCulled=false; stars.renderOrder=2; scene.add(stars);

  function draw(){
    if(disposed||failed)return;
    artwork.style.transform=`translate3d(${(smoothPointer.x*16).toFixed(3)}px,${(smoothPointer.y*11).toFixed(3)}px,0)`;
    camera.position.set(smoothPointer.x*1.2,8-smoothPointer.y*.55,20);
    camera.lookAt(smoothPointer.x*.35,18-smoothPointer.y*.2,-65);
    try{renderer.render(scene,camera);handoff.frameRendered();}catch{fail();}
  }
  function tick(now){
    frame=0;
    if(!enabled||!visible||failed||disposed)return;
    if(previous && now-previous < 1000/30){frame=requestAnimationFrame(tick);return;}
    const elapsed=previous?Math.min((now-previous)/1000,.1):1/30;
    if(previous)clock.value+=Math.min(elapsed,.05);
    previous=now;
    smoothPointer.lerp(pointer,1-Math.exp(-elapsed*7));
    draw();
    if(!failed)frame=requestAnimationFrame(tick);
  }
  function schedule(){
    if(enabled&&visible&&uniforms.uLoaded.value&&!failed&&!disposed&&!frame){previous=0;frame=requestAnimationFrame(tick);}
    else if((!enabled||!visible)&&frame){cancelAnimationFrame(frame);frame=0;previous=0;}
  }
  function resize(){
    const {width,height}=container.getBoundingClientRect();
    if(!width||!height)return;
    const ratio=Math.min(devicePixelRatio,mobile.matches?1.25:1.5);
    renderer.setPixelRatio(ratio); renderer.setSize(width,height,false);
    resolution.value.set(width,height); starUniforms.uPixelRatio.value=ratio;
    camera.aspect=width/height; camera.updateProjectionMatrix(); draw();
  }
  function onPointer(event){
    if(!enabled||!visible||!fine.matches||event.pointerType==='touch')return;
    // Follow only over exposed space. The workspace and dialogs remain calm.
    if(event.target?.closest?.('#app, dialog')){onLeave();return;}
    const clamp=value=>Math.max(-1,Math.min(1,value));
    pointer.set(clamp(event.clientX/innerWidth*2-1),clamp(event.clientY/innerHeight*2-1));
  }
  function onLeave(){pointer.set(0,0);}
  function onPointerOut(event){if(event.relatedTarget===null)onLeave();}
  function saveFrame(){
    if(disposed||failed||!uniforms.uLoaded.value||!backdrop)return;
    return saveRenderedBackground(renderer.getContext(),()=>{
      // Read immediately after rendering; no permanent preserveDrawingBuffer
      // or periodic GPU readbacks are needed. This is only the background.
      renderer.render(scene,camera);
    },()=>{
      const sample=document.createElement('canvas');sample.width=12;sample.height=8;
      const sampleContext=sample.getContext('2d',{willReadFrequently:true});
      sampleContext.drawImage(canvas,0,0,12,8);
      if(!hasBackgroundPixels(sampleContext.getImageData(0,0,12,8).data))return null;
      let imageCanvas=canvas;
      const scale=Math.min(1,Math.sqrt(2600000/(canvas.width*canvas.height)));
      if(scale<1){
        imageCanvas=document.createElement('canvas');imageCanvas.width=Math.round(canvas.width*scale);imageCanvas.height=Math.round(canvas.height*scale);
        imageCanvas.getContext('2d').drawImage(canvas,0,0,imageCanvas.width,imageCanvas.height);
      }
      return imageCanvas.toDataURL('image/jpeg',.92);
    },image=>backdrop.save({version:2,width:innerWidth,height:innerHeight,time:clock.value,x:smoothPointer.x,y:smoothPointer.y,image}));
  }
  function onPageHide(event){
    saveFrame();
    // A normal reload must not leave old contexts competing with the next one.
    // BFCache keeps its live scene and resumes it on pageshow.
    if(!event.persisted){backdrop?.recover();handoff.fail();disposeScene();}
  }
  function fail(){failed=true;cancelAnimationFrame(frame);frame=0;backdrop?.recover();handoff.fail();}
  function onContextLost(event){event.preventDefault();fail();}
  canvas.addEventListener('webglcontextlost',onContextLost);
  const observer=new ResizeObserver(resize);observer.observe(container);
  window.addEventListener('pointermove',onPointer,{passive:true});
  window.addEventListener('pointerout',onPointerOut,{passive:true});
  window.addEventListener('blur',onLeave);
  window.addEventListener('pointercancel',onLeave);
  window.addEventListener('pagehide',onPageHide);
  fine.addEventListener('change',onLeave);
  resize();
  function disposeScene(){
    if(disposed)return;
    disposed=true;handoff.dispose();cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('pointermove',onPointer);window.removeEventListener('pointerout',onPointerOut);window.removeEventListener('blur',onLeave);window.removeEventListener('pointercancel',onLeave);window.removeEventListener('pagehide',onPageHide);fine.removeEventListener('change',onLeave);canvas.removeEventListener('webglcontextlost',onContextLost);artwork.style.removeProperty('transform');scene.traverse(object=>{object.geometry?.dispose();object.material?.dispose();});texture?.dispose();if(!renderer.getContext().isContextLost())renderer.forceContextLoss();renderer.dispose();canvas.remove();
  }
  return {
    setMotion(value){enabled=value&&!reduced.matches;if(!enabled){pointer.set(0,0);smoothPointer.set(0,0);draw();}schedule();},
    setVisible(value){visible=value;schedule();},
    dispose:disposeScene,
  };
}
