// Explicit opt-in: one actual encrypted 10GB service file; only synthetic input.
import {createApp} from '../server.mjs';
import {mkdtemp,mkdir,writeFile,open,unlink} from 'node:fs/promises';
import {verificationFileView} from './verification-file-view.mjs';
import {createHash} from 'node:crypto';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fileBlocks} from '../public/upload-core.js';
import {decryptedBlob} from '../public/encrypted-download.js';
import {createIdentity,sealForPeer,openFromPeer,fileContext,bytesToHex,randomBytes} from '../public/content-crypto.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');await mkdir(join(root,'.qa'),{recursive:true});
const dataDir=await mkdtemp(join(root,'.qa','large-encrypted-'));
const app=await createApp({dataDir,port:0,host:'127.0.0.1'});await app.start();
const base=`http://127.0.0.1:${app.server.address().port}`,started=Date.now(),total=Number(process.env.LAN_VERIFY_BYTES||10_000_000_000),blockSize=8*1024*1024;
if(!Number.isSafeInteger(total)||total<1||total>10_000_000_000){await app.close();throw Error('Invalid verification size');}
let cookie='',peak=0;
async function request(path,body,method=body===undefined?'GET':'POST',headers={}){
 const raw=body instanceof Uint8Array;
 const r=await fetch(base+path,{method,headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':raw?'application/octet-stream':'application/json'}),...headers},body:body===undefined?undefined:raw?body:JSON.stringify(body)});
 cookie=r.headers.get('set-cookie')?.split(';')[0]||cookie;
 if(!r.ok)throw Error(`${r.status}: ${await r.text()}`);return r;
}
const json=async(...args)=>(await request(...args)).json();
try {
 const sender=await json('/api/profile',{nickname:'加密大文件发送测试'}),senderKey=createIdentity();await json('/api/keys',{publicKey:senderKey.publicKey});const senderCookie=cookie;
 cookie='';const receiver=await json('/api/profile',{nickname:'加密大文件独立接收'}),receiverKey=createIdentity();await json('/api/keys',{publicKey:receiverKey.publicKey});const receiverCookie=cookie;
 cookie=senderCookie;const friend=await json('/api/friends/requests',{code:receiver.code});cookie=receiverCookie;await json(`/api/friends/requests/${friend.id}`,{accept:true});
 cookie=senderCookie;const conversationId=(await json('/api/state')).conversations[0].id,secret=bytesToHex(randomBytes(32));
 const creation={conversationId,sender:sender.id,name:'10GB完整加密传输.bin',type:'application/octet-stream',size:total,clientId:'real-encrypted-large'};
 creation.encryption={v:1,key:sealForPeer(senderKey,receiverKey.publicKey,['file-key',fileContext(creation)],secret)};
 const oversized={...creation,size:10_000_000_001,clientId:'over-limit'};
 const over=await fetch(base+'/api/transfers',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(oversized)});if(over.status!==413)throw Error('10GB 上界验证失败');
 let transfer=await json('/api/transfers',creation);
 const expected=createHash('sha256'),block=Buffer.alloc(blockSize,0x75);
 const file={size:total,slice(start,end){const bytes=block.subarray(0,end-start);expected.update(bytes);return {async arrayBuffer(){return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);}};}};
 let index=0;
 for await(const event of fileBlocks(file,blockSize,[],{key:secret,context:fileContext(creation),wireHashes:[]})) {
  if(event.kind==='chunk') {
   const headers={'X-Chunk-SHA256':event.hash,'X-Resume-SHA256':event.resumeHash},bytes=new Uint8Array(event.buffer);
   transfer=await json(`/api/transfers/${transfer.id}/chunks/${event.index}`,bytes,'PUT',headers);index++;peak=Math.max(peak,process.memoryUsage().rss);
   if(index===2){const progress=await json(`/api/transfers/${transfer.id}`);if(progress.offset!==2*blockSize)throw Error('续传偏移错误');await json(`/api/transfers/${transfer.id}/chunks/${event.index}`,bytes,'PUT',headers);}
   if(index%120===0||transfer.offset===total)console.log(`加密上传 ${(transfer.offset/1e9).toFixed(2)} / ${(total/1e9).toFixed(2)} GB`);
  } else if(event.kind==='complete')transfer=await json(`/api/transfers/${transfer.id}/complete`,{sha256:event.sha256,manifest:event.manifest});
 }
 const expectedHash=expected.digest('hex');console.log('加密上传及落盘校验完成，开始接收方分块解密验证');
 cookie=receiverCookie;const remote=(await json('/api/state')).conversations[0].transfers[0];
 const decodedKey=openFromPeer(receiverKey,remote.encryption.key,['file-key',fileContext(remote)]);if(decodedKey!==secret)throw Error('接收方密钥封装错误');
 const originalHash=createHash('sha256');let received=0,lastLogged=0;
 const decodedPath=join(dataDir,'verified-download.bin');
 const sink=async()=>{
  let writer=await open(decodedPath,'wx');
  return {
   async append(bytes){originalHash.update(bytes);let position=0;while(position<bytes.length){const out=await writer.write(bytes,position,bytes.length-position,received+position);if(!out.bytesWritten)throw Error('Receiver disk write failed');position+=out.bytesWritten;}received+=bytes.length;peak=Math.max(peak,process.memoryUsage().rss);if(received-lastLogged>=1_000_000_000||received===total){lastLogged=received;console.log(`解密校验 ${(received/1e9).toFixed(2)} / ${(total/1e9).toFixed(2)} GB`);}},
   async finish(){await writer.sync();await writer.close();writer=null;return verificationFileView(decodedPath);},
   async abort(){if(writer)await writer.close();await unlink(decodedPath).catch(()=>{});}
  };
 };
 const response=await request(`/api/transfers/${remote.id}/download`);
 await decryptedBlob(response,remote,decodedKey,()=>{},{diskSink:sink});
 if(received!==total||originalHash.digest('hex')!==expectedHash)throw Error('解密后的字节或摘要不匹配');
 const report={passed:true,bytes:total,wireBytes:remote.wireSize,sha256:expectedHash,peakRssMB:+(peak/1e6).toFixed(1),seconds:+((Date.now()-started)/1000).toFixed(1),browser10GBExecuted:false,
  checks:['encrypted large upload','10GB+1 rejected','original-byte resume offset','idempotent ciphertext chunk retry','per-block disk re-verification','ciphertext SHA256','recipient key unwrap','authenticated streamed decryption','receiver actual saved file','final saved-file SHA256','independent original SHA256'],downloadSink:'Node file-backed stream adapter with 64-bit stat; browser IndexedDB Blob downloads verified separately'};
 await writeFile(join(root,'.qa','encrypted-large-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {await app.close();}
