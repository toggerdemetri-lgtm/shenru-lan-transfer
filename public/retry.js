function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export async function withRetry(action, { signal, onRetry = () => {} }) {
  let count = 0;
  while (!signal.aborted) {
    try { return await action(); }
    catch (error) {
      if (error.name === 'AbortError' || (error.status && ![408, 429, 500, 502, 503, 504].includes(error.status))) throw error;
      if (signal.aborted) break;
      onRetry(count); await delay(Math.min(1000 * 2 ** count++, 10000), signal);
    }
  }
  throw new DOMException('Aborted', 'AbortError');
}
