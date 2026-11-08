import { fileBlocks } from './upload-core.js';
let acknowledge;
self.onmessage = async ({ data }) => {
  if (data.kind === 'ack') { acknowledge?.(); return; }
  if (data.kind !== 'start') return;
  try {
    for await (const event of fileBlocks(data.file, data.chunkSize, data.hashes, data.encryption)) {
      if (event.kind === 'chunk') {
        const next = new Promise(resolve => { acknowledge = resolve; });
        self.postMessage(event, [event.buffer]); await next;
      } else self.postMessage(event);
    }
  } catch (error) { self.postMessage({ kind: 'error', message: error.message }); }
};
