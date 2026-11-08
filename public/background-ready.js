export function createBackgroundHandoff(artwork, schedule = requestAnimationFrame) {
  let textured = false, queued = false, stopped = false;
  return {
    textureReady() { textured = true; },
    frameRendered() {
      if (!textured || queued || stopped) return;
      queued = true;
      schedule(() => { if (!stopped) artwork.dataset.renderer = 'webgl'; });
    },
    fail() { stopped = true; artwork.dataset.renderer = 'static'; },
    dispose() { stopped = true; }
  };
}
