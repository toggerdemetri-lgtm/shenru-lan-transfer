import { sha256 } from './vendor/noble-hashes/sha2.js';
import { bytesToHex } from './vendor/noble-hashes/utils.js';
import { sealBlock, resumeFingerprint, sealManifest, hexToBytes } from './content-crypto.js';
export async function* fileBlocks(file, chunkSize, knownHashes, encryption) {
  if (knownHashes.length > Math.ceil(file.size / chunkSize)) throw new Error('所选文件与已上传部分不一致');
  const entire = sha256.create(), wireCommitment = sha256.create();
  const key=encryption ? hexToBytes(encryption.key) : null;
  for (let offset = 0, index = 0; offset < file.size; offset += chunkSize, index++) {
    const buffer = await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer();
    const bytes = new Uint8Array(buffer); const hash = encryption ? resumeFingerprint(key,encryption.context,index,bytes) : bytesToHex(sha256(bytes)); entire.update(bytes);
    if (index < knownHashes.length) {
      if (hash !== knownHashes[index]) throw new Error('所选文件与已上传部分不一致，请选择原文件');
      if(encryption)wireCommitment.update(hexToBytes(encryption.wireHashes[index]));
      yield { kind: 'verified', index, bytes: offset + buffer.byteLength };
    } else if(encryption) {
      const wire=sealBlock(key,encryption.context,index,bytes),wireHash=bytesToHex(sha256(wire));wireCommitment.update(hexToBytes(wireHash));
      yield {kind:'chunk',index,hash:wireHash,resumeHash:hash,plainLength:bytes.length,buffer:wire.buffer};
    } else yield { kind: 'chunk', index, hash, buffer };
  }
  const originalHash=bytesToHex(entire.digest());
  yield encryption ? {kind:'complete',sha256:bytesToHex(wireCommitment.digest()),manifest:sealManifest(key,encryption.context,originalHash)} : { kind: 'complete', sha256: originalHash };
}
