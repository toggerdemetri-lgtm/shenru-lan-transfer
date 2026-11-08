import { x25519 } from './vendor/noble-curves/ed25519.js';
import { xchacha20poly1305 } from './vendor/noble-ciphers/chacha.js';
import { hkdf } from './vendor/noble-hashes/hkdf.js';
import { hmac } from './vendor/noble-hashes/hmac.js';
import { sha256 } from './vendor/noble-hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from './vendor/noble-hashes/utils.js';

export { bytesToHex, hexToBytes };
export const WIRE_OVERHEAD = 40;
const DOMAIN = utf8ToBytes('shenru-content-v1');
const encode = value => utf8ToBytes(JSON.stringify(value));
export function randomBytes(length) { return globalThis.crypto.getRandomValues(new Uint8Array(length)); }
export function createIdentity() { const secretKey = randomBytes(32); return { secretKey, publicKey: bytesToHex(x25519.getPublicKey(secretKey)) }; }
export function validPublicKey(value) {
 if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return false;
 try { x25519.getSharedSecret(new Uint8Array(32).fill(42),hexToBytes(value)); return true; } catch { return false; }
}
function derive(key, context, purpose) { return hkdf(sha256,key,DOMAIN,encode([purpose,context]),32); }
function peerKey(identity, box, context) {
 if (![box.senderKey,box.recipientKey].includes(identity.publicKey) || box.v !== 1 || !validPublicKey(box.senderKey) || !validPublicKey(box.recipientKey)) throw Error('加密密钥不匹配，无法读取此内容');
 const other=identity.publicKey===box.senderKey ? box.recipientKey : box.senderKey;
 return derive(x25519.getSharedSecret(identity.secretKey,hexToBytes(other)),[box.senderKey,box.recipientKey,context],'peer-envelope');
}
export function sealForPeer(identity, recipientKey, context, text) {
 const box={v:1,senderKey:identity.publicKey,recipientKey,nonce:bytesToHex(randomBytes(24))};
 const aad=encode([box.v,box.senderKey,box.recipientKey,context]);
 box.ciphertext=bytesToHex(xchacha20poly1305(peerKey(identity,box,context),hexToBytes(box.nonce),aad).encrypt(utf8ToBytes(text)));
 return box;
}
export function openFromPeer(identity, box, context) {
 const aad=encode([box.v,box.senderKey,box.recipientKey,context]);
 const bytes=xchacha20poly1305(peerKey(identity,box,context),hexToBytes(box.nonce),aad).decrypt(hexToBytes(box.ciphertext));
 return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
function seal(key, context, purpose, bytes) {
 const nonce=randomBytes(24), ciphertext=xchacha20poly1305(derive(key,context,purpose),nonce,encode([purpose,context])).encrypt(bytes);
 const out=new Uint8Array(nonce.length+ciphertext.length);out.set(nonce);out.set(ciphertext,nonce.length);return out;
}
function unseal(key, context, purpose, bytes) {
 if(bytes.length<WIRE_OVERHEAD)throw Error('加密内容不完整');
 return xchacha20poly1305(derive(key,context,purpose),bytes.subarray(0,24),encode([purpose,context])).decrypt(bytes.subarray(24));
}
export const sealBlock=(key,context,index,bytes)=>seal(key,[context,index],'file-block',bytes);
export const openBlock=(key,context,index,bytes)=>unseal(key,[context,index],'file-block',bytes);
export const resumeFingerprint=(key,context,index,bytes)=>bytesToHex(hmac(sha256,derive(key,[context,index],'resume-fingerprint'),bytes));
export const sealManifest=(key,context,sha)=>bytesToHex(seal(key,context,'file-manifest',utf8ToBytes(sha)));
export function openManifest(key,context,value) {
 const hash=new TextDecoder('utf-8',{fatal:true}).decode(unseal(key,context,'file-manifest',hexToBytes(value)));
 if(!/^[a-f0-9]{64}$/.test(hash))throw Error('原文件校验信息无效');return hash;
}
export const fileContext=tr=>['file',tr.conversationId,tr.sender,tr.clientId,tr.name,tr.size,tr.type];
export const messageContext=(conversationId,sender,clientId)=>['message',conversationId,sender,clientId];
