import { sha256 } from './vendor/noble-hashes/sha2.js';
import { checkDownloadResponse, BUFFERED_DOWNLOAD_LIMIT } from './download-core.js';
import { openBlock, openManifest, fileContext, hexToBytes, bytesToHex, WIRE_OVERHEAD } from './content-crypto.js';
import { diskBlobSink } from './download-spool.js';

export async function decryptedBlob(response,file,secret,onProgress=()=>{},options={}) {
 let reader,verificationReader,sink;
 const signal=options.signal;
 const checkCancelled=()=>{if(signal?.aborted)throw new DOMException('下载已取消','AbortError');};
 const cancelReaders=()=>{reader?.cancel().catch(()=>{});verificationReader?.cancel().catch(()=>{});};
 signal?.addEventListener('abort',cancelReaders,{once:true});
 try {
  checkCancelled();
  const key=hexToBytes(secret),context=fileContext(file),expectedHash=openManifest(key,context,file.manifest);
  if(!Number.isSafeInteger(file.chunkSize)||file.chunkSize<1||file.chunkSize>64*1024*1024||file.wireSize!==file.size+Math.ceil(file.size/file.chunkSize)*WIRE_OVERHEAD)throw Error('加密分块信息无效');
  checkDownloadResponse(response,{...file,size:file.wireSize});
  const parts=[];
  sink=options.diskSink ? await options.diskSink(file.size) : file.size>BUFFERED_DOWNLOAD_LIMIT ? await diskBlobSink(file.size) : {async append(bytes){parts.push(new Blob([bytes]));},async finish(type){return new Blob(parts,{type});},async abort(){parts.length=0;}};
  const wireHash=sha256.create(),plainHash=sha256.create();let received=0,plainReceived=0,index=0,filled=0;
  let block=new Uint8Array(file.size?Math.min(file.chunkSize,file.size)+WIRE_OVERHEAD:0);
  if(!response.body)throw Error('未收到加密文件');reader=response.body.getReader();
  while(true) {
   checkCancelled();const {value,done}=await reader.read();checkCancelled();if(done)break;
   received+=value.byteLength;if(received>file.wireSize)throw Error('加密文件大小不一致');wireHash.update(value);onProgress(received);
   let offset=0;
   while(offset<value.byteLength) {
    const count=Math.min(block.length-filled,value.byteLength-offset);if(!count)throw Error('加密分块长度无效');
    block.set(value.subarray(offset,offset+count),filled);offset+=count;filled+=count;
    if(filled===block.length) {
     const plain=openBlock(key,context,index++,block);plainHash.update(plain);plainReceived+=plain.length;
     await sink.append(plain);checkCancelled();options.onState?.({phase:'decrypting',bytes:plainReceived,total:file.size});checkCancelled();filled=0;
     const remaining=file.size-plainReceived;block=new Uint8Array(remaining?Math.min(file.chunkSize,remaining)+WIRE_OVERHEAD:0);
    }
   }
  }
  if(received!==file.wireSize||plainReceived!==file.size||filled!==0)throw Error('加密文件下载不完整');
  if(bytesToHex(wireHash.digest())!==file.sha256||bytesToHex(plainHash.digest())!==expectedHash)throw Error('原文件完整性校验失败');
  checkCancelled();const blob=await sink.finish(file.type||'application/octet-stream');checkCancelled();
  if(blob.size!==file.size)throw Error('下载暂存大小不一致，未保存不完整文件');
  // Hash the actual assembled Blob, not just the bytes that entered temporary storage.
  const savedHash=sha256.create();let verified=0;
  options.onState?.({phase:'verifying',bytes:0,total:file.size});checkCancelled();
  verificationReader=blob.stream().getReader();
  while(true){checkCancelled();const {value,done}=await verificationReader.read();checkCancelled();if(done)break;savedHash.update(value);verified+=value.byteLength;onProgress(received);options.onState?.({phase:'verifying',bytes:verified,total:file.size});}
  if(verified!==file.size || bytesToHex(savedHash.digest())!==expectedHash)throw Error('暂存后的原文件内容校验失败，未保存此文件');
  return blob;
 } catch(error) {
  if(reader)await reader.cancel().catch(()=>{});else await response.body?.cancel().catch(()=>{});
  if(signal?.aborted)throw new DOMException('下载已取消','AbortError');if(error.name==='AbortError')throw error;
  throw Error('加密文件未保存：'+(error.message||'解密或校验失败'));
 } finally {signal?.removeEventListener('abort',cancelReaders);reader?.releaseLock();verificationReader?.releaseLock();await sink?.abort().catch(()=>{});}
}
