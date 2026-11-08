// Node-only verification adapter. fs.openAsBlob in the bundled runtime truncates
// sizes above 4GiB; use the real stat and a bounded native file stream instead.
import {stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {Readable} from 'node:stream';

export async function verificationFileView(path) {
 const metadata=await stat(path);
 return {size:metadata.size,type:'application/octet-stream',stream:()=>Readable.toWeb(createReadStream(path,{highWaterMark:65536}))};
}
