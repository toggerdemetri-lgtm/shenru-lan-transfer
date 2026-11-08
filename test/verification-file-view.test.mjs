import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,open,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verificationFileView} from '../scripts/verification-file-view.mjs';

test('large verification view retains exact 64-bit file length beyond 4GiB without buffering it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'shenru-file-view-')),path=join(dir,'sparse.bin');
 try {
  const file=await open(path,'wx');await file.truncate(2**32+123);await file.close();
  const view=await verificationFileView(path);assert.equal(view.size,2**32+123);
  const reader=view.stream().getReader();const first=await reader.read();assert.ok(first.value.length>0 && first.value.length<=65536);await reader.cancel();
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('verification view streams exact saved bytes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'shenru-file-view-')),path=join(dir,'small.bin');
 try {const bytes=Buffer.from('actual saved original bytes');await writeFile(path,bytes);const view=await verificationFileView(path);assert.equal(view.size,bytes.length);assert.deepEqual(Buffer.from(await new Response(view.stream()).arrayBuffer()),bytes);}
 finally{await rm(dir,{recursive:true,force:true});}
});
