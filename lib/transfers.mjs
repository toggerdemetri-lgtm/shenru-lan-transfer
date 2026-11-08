import { randomUUID, createHash } from 'node:crypto';
import { open, unlink, rename, statfs } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { requireThat, digest } from './identity.mjs';
export async function readBody(req, limit) {
  const length = Number(req.headers['content-length']);
  requireThat(!Number.isFinite(length) || length <= limit, 413, '请求内容超过允许大小');
  const parts = []; let total = 0;
  for await (const part of req) { total += part.length; requireThat(total <= limit, 413, '请求内容超过允许大小'); parts.push(part); }
  return Buffer.concat(parts, total);
}
export class TransferStore {
  constructor(directory, config, changed) { this.directory = directory; this.config = config; this.changed = changed; this.items = new Map(); this.reserved = 0; this.creating = Promise.resolve(); }
  view(tr) {
    const { id, conversationId, sender, name, size, type, offset, hashes, sha256, status, chunkSize, clientId, seq, time } = tr;
    return { id, conversationId, sender, name, size, type, offset, hashes: [...hashes], sha256, status, chunkSize, clientId, seq, time,
      completedAt: tr.completedAt ?? null, elapsedMs: tr.elapsedMs ?? null,
      ...(tr.encryption ? {encryption:tr.encryption,resumeHashes:[...tr.resumeHashes],wireSize:tr.wireSize,manifest:tr.manifest || null}: {}) };
  }
  async create(user, session, body) {
    const job = this.creating.catch(() => {}).then(() => this.createOne(user, session, body));
    this.creating = job.catch(() => {}); return job;
  }
  async createOne(user, session, body) {
    const { size, name, clientId } = body;
    requireThat(Number.isSafeInteger(size) && size >= 0, 400, '文件大小无效');
    requireThat(size <= this.config.maxFileSize, 413, '单文件不能超过 10GB');
    requireThat(typeof name === 'string' && name.length > 0 && name.length <= 255 && name.isWellFormed() && !/[\x00-\x1f]/.test(name), 400, '文件名无效');
    requireThat(typeof clientId === 'string' && /^[\w-]{1,100}$/.test(clientId), 400, '上传标识无效');
    const prior = [...this.items.values()].find(x => x.sender === user.id && x.clientId === clientId);
    if (prior) { requireThat(prior.conversationId === session.id && prior.name === name && prior.size === size && prior.type === (typeof body.type==='string'?body.type.slice(0,120):'application/octet-stream') && JSON.stringify(prior.encryption)===JSON.stringify(body.encryption), 409, '上传标识已经用于其他文件'); return this.view(prior); }
    const wireSize=size+(body.encryption ? Math.ceil(size/this.config.chunkSize)*40 : 0);
    requireThat(this.reserved + wireSize <= this.config.quotaBytes, 507, '临时文件空间额度不足，请取消不需要的上传或等待会话清理');
    this.reserved += wireSize;
    const tr = { id: randomUUID(), clientId, conversationId: session.id, sender: user.id, name, size,
      type: typeof body.type === 'string' ? body.type.slice(0, 120) : 'application/octet-stream', offset: 0, hashes: [],
      status: 'uploading', sha256: null, chunkSize: this.config.chunkSize, tail: Promise.resolve(), released: false,
      encryption:body.encryption,wireSize,wireOffset:0,resumeHashes:[] };
    try {
      const disk = await statfs(this.directory);
      const pending = [...this.items.values()].filter(x => !x.released).reduce((n, x) => n + x.wireSize - x.wireOffset, wireSize);
      requireThat(disk.bavail * disk.bsize - pending >= this.config.reserveBytes, 507, '磁盘可用空间不足，需要保留安全余量');
      requireThat(!session.closed, 410, '会话已清理');
      const file = await open(this.path(tr), 'wx'); await file.close(); requireThat(!session.closed, 410, '会话已清理');
      tr.time = Date.now(); this.items.set(tr.id, tr); tr.seq = this.changed(session.id); return this.view(tr);
    } catch (e) { this.reserved -= wireSize; await unlink(this.path(tr)).catch(() => {}); throw e; }
  }
  path(tr, ready = tr.status === 'ready') { return join(this.directory, `${tr.id}.${ready ? 'bin' : 'part'}`); }
  get(id) { const tr = this.items.get(id); requireThat(tr, 404, '文件不存在或会话已清理'); return tr; }
  async serial(tr, action) { const job = tr.tail.catch(() => {}).then(action); tr.tail = job.catch(() => {}); return job; }
  async chunk(tr, index, bytes, checksum, resumeHash) {
    requireThat(Number.isSafeInteger(index) && index >= 0, 400, '分块序号无效');
    requireThat(/^[a-f0-9]{64}$/.test(checksum || ''), 400, '缺少分块校验值');
    requireThat(digest(bytes) === checksum, 422, '分块校验失败，请重试');
    if(tr.encryption)requireThat(/^[a-f0-9]{64}$/.test(resumeHash || ''),400,'缺少加密续传校验值');
    return this.serial(tr, async () => {
      requireThat(tr.status !== 'cancelled' && !tr.closed, 410, '上传已取消或会话已清理');
      const expected = Math.min(tr.chunkSize, tr.size - index * tr.chunkSize);
      requireThat(expected > 0 && bytes.length === expected+(tr.encryption?40:0), 400, '分块大小不正确');
      if (index < tr.hashes.length) { requireThat(tr.hashes[index] === checksum && (!tr.encryption || tr.resumeHashes[index]===resumeHash), 409, '已上传部分与所选文件不一致'); return this.view(tr); }
      requireThat(tr.status === 'uploading' && index === tr.hashes.length, 409, '上传进度已变化，请重新同步');
      const disk = await statfs(this.directory);
      requireThat(disk.bavail * disk.bsize - bytes.length >= this.config.reserveBytes, 507, '磁盘空间不足，请释放空间后继续');
      const file = await open(this.path(tr), 'r+');
      try {
        let written = 0;
        while (written < bytes.length) { const out = await file.write(bytes, written, bytes.length - written, tr.wireOffset + written); requireThat(out.bytesWritten > 0, 507, '无法写入文件'); written += out.bytesWritten; }
        await file.sync();
      } catch (e) { await file.truncate(tr.wireOffset).catch(() => {}); throw e; }
      finally { await file.close(); }
      tr.offset += expected; tr.wireOffset += bytes.length; tr.hashes.push(checksum); if(tr.encryption)tr.resumeHashes.push(resumeHash); this.changed(tr.conversationId); return this.view(tr);
    });
  }
  async complete(tr, checksum, elapsedMs, manifest) {
    requireThat(/^[a-f0-9]{64}$/.test(checksum || ''), 400, '缺少完整文件校验值');
    return this.serial(tr, async () => {
      requireThat(!tr.closed && tr.status !== 'cancelled', 410, '上传已取消或会话已清理');
      if(tr.encryption)requireThat(typeof manifest==='string' && /^[a-f0-9]{208}$/.test(manifest),400,'缺少加密原文件校验信息');
      if (tr.status === 'ready') { requireThat(checksum === (tr.encryption?tr.commitment:tr.sha256) && (!tr.encryption || manifest===tr.manifest), 409, '校验值与文件不一致'); return this.view(tr); }
      requireThat(tr.offset === tr.size, 409, '文件尚未上传完整');
      const verificationStarted = Date.now();
      const hash = createHash('sha256'); let length = 0;
      if(tr.encryption) {
        const commitment=createHash('sha256');for(const h of tr.hashes)commitment.update(Buffer.from(h,'hex'));
        requireThat(commitment.digest('hex')===checksum,422,'加密分块清单校验失败');
        // Verify stored blocks again: a disk write failure must not become a valid whole-file hash.
        const file=await open(this.path(tr),'r');
        try { for(let i=0;i<tr.hashes.length;i++) {
          const expected=Math.min(tr.chunkSize,tr.size-i*tr.chunkSize)+40,block=Buffer.alloc(expected);let read=0;
          while(read<expected){const n=await file.read(block,read,expected-read,length+read);if(!n.bytesRead)break;read+=n.bytesRead;}
          requireThat(read===expected && digest(block)===tr.hashes[i],422,'加密文件落盘校验失败，请重新发送');hash.update(block);length+=read;
        }
        requireThat((await file.stat()).size===length,422,'加密文件长度校验失败');
        } finally { await file.close(); }
      } else for await (const data of createReadStream(this.path(tr))) { hash.update(data); length += data.length; }
      const wireHash=hash.digest('hex');
      requireThat(length === tr.wireSize && (tr.encryption || wireHash === checksum), 422, '完整文件校验失败，请重新发送');
      await rename(this.path(tr), this.path(tr, true));
      tr.completedAt = Date.now();
      tr.elapsedMs = Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, elapsedMs + tr.completedAt - verificationStarted) : null;
      tr.sha256 = wireHash; if(tr.encryption){tr.commitment=checksum;tr.manifest=manifest;} tr.status = 'ready'; this.changed(tr.conversationId); return this.view(tr);
    });
  }
  async cancel(tr) {
    return this.serial(tr, async () => {
      requireThat(tr.status !== 'ready', 409, '已完成的文件将在会话结束后清理');
      if (tr.status === 'cancelled') return { ok: true };
      await unlink(this.path(tr)).catch(e => { if (e.code !== 'ENOENT') throw e; });
      tr.status = 'cancelled'; this.release(tr); this.changed(tr.conversationId); return { ok: true };
    });
  }
  release(tr) { if (!tr.released) { this.reserved -= tr.wireSize; tr.released = true; } }
  async clearConversation(id) {
    const items = [...this.items.values()].filter(tr => tr.conversationId === id);
    for (const tr of items) tr.closed = true;
    await Promise.all(items.map(tr => this.serial(tr, async () => {
      await unlink(this.path(tr)).catch(e => { if (e.code !== 'ENOENT') throw e; });
      this.release(tr); this.items.delete(tr.id);
    })));
  }
}
export function parseRange(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  requireThat(match && (match[1] || match[2]) && size > 0, 416, '下载范围无效');
  let start, end;
  if (!match[1]) { const suffix = Number(match[2]); requireThat(suffix > 0, 416, '下载范围无效'); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  requireThat(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < size && end >= start, 416, '下载范围无效');
  return { start, end, partial: true };
}
