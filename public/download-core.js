import { sha256 } from './vendor/noble-hashes/sha2.js';
import { bytesToHex } from './vendor/noble-hashes/utils.js';

export const BUFFERED_DOWNLOAD_LIMIT = 64 * 1024 * 1024;

export function checkDownloadResponse(response, file) {
  if (response.status === 401 || response.status === 403) throw Error('下载身份或连接已失效，请刷新网页后重试');
  if (!response.ok) throw Error('下载连接失败，请确认主机仍在运行后重试');
  if (response.status !== 200) throw Error('没有收到完整文件响应，请重新下载，避免保存部分范围内容');
  if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) throw Error('文件校验信息无效，请刷新后重新下载');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) !== file.size)) throw Error('下载文件大小不一致，未保存此文件，请重试');
  const etag = response.headers.get('etag');
  if (etag && etag !== `"${file.sha256}"`) throw Error('下载文件校验标识已变化，请刷新后重试');
}

export async function verifiedBlob(response, file, onProgress = () => {}) {
  if (file.size > BUFFERED_DOWNLOAD_LIMIT) { await response.body?.cancel(); throw Error('大文件请使用浏览器流式下载'); }
  let reader;
  try {
    checkDownloadResponse(response, file);
    const hash = sha256.create(), parts = [];
    let received = 0;
    if (!response.body) throw Error('没有收到完整文件，请重新下载');
    reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      received += value.byteLength;
      if (received > file.size) throw Error('下载文件大小不一致，未保存此文件，请重试');
      hash.update(value); parts.push(value); onProgress(received);
    }
    if (received !== file.size) throw Error('文件下载不完整，未保存此文件，请重试');
    if (bytesToHex(hash.digest()) !== file.sha256) throw Error('下载内容校验失败，未保存此文件，请重新下载');
    return new Blob(parts, { type: 'application/octet-stream' });
  } catch (error) {
    if (reader) await reader.cancel().catch(() => {}); else await response.body?.cancel().catch(() => {});
    throw error;
  } finally { reader?.releaseLock(); }
}
