import { validPublicKey } from '../public/content-crypto.js';
import { requireThat } from './identity.mjs';
export { validPublicKey };
export function envelope(value, senderKey, recipientKey, maxCiphertext = 96032) {
 requireThat(value && value.v===1 && validPublicKey(value.senderKey) && validPublicKey(value.recipientKey)
  && value.senderKey===senderKey && value.recipientKey===recipientKey
  && typeof value.nonce==='string' && /^[a-f0-9]{48}$/.test(value.nonce)
  && typeof value.ciphertext==='string' && value.ciphertext.length>=32 && value.ciphertext.length<=maxCiphertext
  && value.ciphertext.length%2===0 && /^[a-f0-9]+$/.test(value.ciphertext),400,'加密信息无效或对方密钥已变化，请刷新后重试');
 // Strip unknown fields so untrusted callers cannot smuggle plaintext into snapshots.
 return {v:1,senderKey:value.senderKey,recipientKey:value.recipientKey,nonce:value.nonce,ciphertext:value.ciphertext};
}
