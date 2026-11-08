/* finesse · ambient background · prefers-reduced-motion respected */
const button = document.getElementById('background-motion');
const artwork = document.querySelector('.star-art');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const preferenceKey = 'jinlin-background-motion';
let preferred = true;
try { preferred = localStorage.getItem(preferenceKey) !== 'off'; } catch { /* Storage is optional. */ }
let scene;
function sync() {
  const enabled = preferred && !reduced.matches;
  const available = artwork.dataset.renderer === 'webgl';
  const active = enabled && available;
  button.disabled = !available || reduced.matches;
  button.setAttribute('aria-pressed', String(active));
  const label = !available ? '静态背景' : reduced.matches ? '已减少动态效果' : active ? '关闭动效' : '开启动效';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.querySelector('.background-motion-label').textContent = label;
  button.querySelector('.background-motion-icon').textContent = active ? 'Ⅱ' : '▷';
  scene?.setMotion(enabled);
  scene?.setVisible(!document.hidden);
}
button.addEventListener('click', () => {
  preferred = !preferred;
  try { localStorage.setItem(preferenceKey, preferred ? 'on' : 'off'); } catch { /* Storage is optional. */ }
  sync();
});
reduced.addEventListener('change', sync);
document.addEventListener('visibilitychange', sync);
window.addEventListener('pagehide', () => scene?.setVisible(false));
window.addEventListener('pageshow', sync);
sync();
import('./star-scene.js').then(({ createStarScene }) => {
  scene = createStarScene(document.getElementById('star-scene'), document.body);
  sync();
  // A context loss can switch to the still after initialization.
  new MutationObserver(sync).observe(artwork, { attributes: true, attributeFilter: ['data-renderer'] });
}).catch(() => { artwork.dataset.renderer = 'static'; sync(); });
