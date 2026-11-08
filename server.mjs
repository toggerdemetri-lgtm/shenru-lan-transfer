import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, unlink, open, readFile, lstat } from 'node:fs/promises';
import { resolve, join, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { IdentityStore, requireThat, HttpError } from './lib/identity.mjs';
import { TransferStore, readBody, parseRange } from './lib/transfers.mjs';
import { lanAddresses, renderEntry } from './lib/entry.mjs';
import { envelope, validPublicKey } from './lib/content-policy.mjs';
import { acquireLock } from './lib/service-lock.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
// Keep the complete first-paint image inside the blocking head style. A separate
// streamed PNG can otherwise paint a few rows before the rest has decoded.
const BOOT_STYLE = 'html,body{background:#060c20;color-scheme:dark}:root{--nebula-image:url("data:image/jpeg;base64,' + (await readFile(join(ROOT,'public','nebula-boot.jpg'))).toString('base64') + '")}';
const BOOT_STYLE_HASH = 'sha256-' + createHash('sha256').update(BOOT_STYLE).digest('base64');
const BOOT_PAGE = Buffer.from((await readFile(join(ROOT,'public','index.html'),'utf8')).replace(/<style id="boot-colors">[^<]+<\/style>/, '<style id="boot-colors">'+BOOT_STYLE+'</style>'));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.jpg': 'image/jpeg' };
const CONFIG = { port: 3000, host: '0.0.0.0', chunkSize: 8 * 1024 * 1024,
  maxFileSize: 10_000_000_000, quotaBytes: 50_000_000_000, reserveBytes: 1_000_000_000,
  graceMs: 300_000, heartbeatMs: 15_000, heartbeatTimeoutMs: 45_000, sweepMs: 1000, maxUploads: 8 };

export async function createApp(options = {}) {
  const config = { ...CONFIG, ...options };
  requireThat(Number.isInteger(config.port) && config.port >= 0 && config.port <= 65535, 400, '端口需要是 0–65535 的整数');
  for (const key of ['chunkSize', 'maxFileSize', 'quotaBytes', 'reserveBytes', 'graceMs', 'heartbeatMs', 'heartbeatTimeoutMs', 'sweepMs', 'maxUploads'])
    requireThat(Number.isSafeInteger(config[key]) && config[key] >= (key === 'reserveBytes' ? 0 : 1), 400, `配置 ${key} 无效`);
  const dataDir = resolve(options.dataDir || join(ROOT, '.data'));
  const temporary = join(dataDir, 'transfers');
  await mkdir(temporary, { recursive: true });
  requireThat(!(await lstat(temporary)).isSymbolicLink(), 400, '临时目录不能是符号链接或目录联接');
  const unlock = await acquireLock(dataDir);
  let identities;
  try {
    // Only unlink files in this application's dedicated directory; never recurse.
    for (const file of await readdir(temporary, { withFileTypes: true })) if (file.isFile() || file.isSymbolicLink()) await unlink(join(temporary, file.name));
    identities = new IdentityStore(join(dataDir, 'identity.sqlite'));
  } catch (e) { await unlock(); throw e; }
  const sessions = new Map(), pairs = new Map(), connections = new Map(), leases = new Map(), active = new Map();
  let seq = 0, log = [], closing = false, closed = false, uploading = 0, sweepRunning = false;
  const bootId = randomUUID();
  const serviceInfo = { app: 'shenru-lan', protocol: 1, contentEncryption:1, bootId, startedAt: options.startedAt || Date.now() };
  function publish(type = 'sync', conversationId) {
    const event = { seq: ++seq, type, conversationId };
    log.push(event); if (log.length > 1000) log.shift();
    const text = `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
    const members = conversationId ? sessions.get(conversationId)?.members : null;
    for (const [userId, set] of connections) for (const res of set) {
      if (conversationId && !members?.includes(userId)) continue;
      if (res.writableLength > 1_000_000) res.destroy(); else res.write(text);
    }
    return event.seq;
  }
  const transfers = new TransferStore(temporary, config, id => publish('transfer', id));
  const online = id => !!connections.get(id)?.size || (active.get(id) || 0) > 0 || [...(leases.get(id)?.values() || [])].some(t => Date.now() - t < config.heartbeatTimeoutMs);
  function activity(userId) {
    active.set(userId, (active.get(userId) || 0) + 1); updateDeadlines();
    let released = false;
    return () => { if (!released) { released = true; active.set(userId, Math.max(0, (active.get(userId) || 0) - 1)); updateDeadlines(); } };
  }
  function updateDeadlines() {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (session.members.some(online)) session.offlineAt = null;
      else if (session.offlineAt === null) session.offlineAt = now;
    }
  }
  function conversation(a, b) {
    const key = [a, b].sort().join(':'); let session = pairs.get(key);
    if (!session || session.closed) {
      session = { id: randomUUID(), key, members: [a, b], messages: [], dedup: new Map(), closed: false, offlineAt: null };
      sessions.set(session.id, session); pairs.set(key, session); updateDeadlines();
    }
    return session;
  }
  function access(user, id) {
    const session = sessions.get(id);
    requireThat(session && !session.closed && session.members.includes(user.id), 403, '没有访问这个会话的权限');
    requireThat(identities.isFriend(...session.members), 403, '需要先成为好友'); return session;
  }
  function transferAccess(user, id) { const tr = transfers.get(id); const session = access(user, tr.conversationId); return { tr, session }; }
  function snapshot(user) {
    const friends = identities.friends(user.id).map(x => ({ ...x, online: online(x.id) }));
    return { bootId, seq, me: user, friends, requests: identities.requests(user.id),
      online: [...new Set([...connections.keys(), ...leases.keys()])].filter(id => id !== user.id && online(id)).map(id => identities.get(id)).filter(Boolean),
      conversations: friends.map(friend => {
        const session = conversation(user.id, friend.id);
        return { id: session.id, peerId: friend.id, messages: session.messages,
          transfers: [...transfers.items.values()].filter(x => x.conversationId === session.id).map(x => transfers.view(x)) };
      }), config: { chunkSize: config.chunkSize, maxFileSize: config.maxFileSize, graceMs: config.graceMs, contentEncryption:1 },
      storage: { reserved: transfers.reserved, quota: config.quotaBytes } };
  }
  function json(res, value, status = 200) {
    if (!res.destroyed && !res.headersSent) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
  }
  async function body(req) {
    try {
      const value = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8'));
      requireThat(value && typeof value === 'object' && !Array.isArray(value), 400, '请求格式无效'); return value;
    } catch (e) { if (e instanceof SyntaxError) throw new HttpError(400, '请求不是有效 JSON'); throw e; }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' '${BOOT_STYLE_HASH}'; img-src 'self' blob: data:; worker-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`);
    try {
      requireThat(!closing, 503, '服务正在关闭');
      const url = new URL(req.url, 'http://localhost'); const path = url.pathname; const method = req.method;
      if (path === '/api/service-info' && method === 'GET') { json(res, serviceInfo); return; }
      if (path === '/share.html' && (method === 'GET' || method === 'HEAD')) {
        const { port, address } = server.address();
        const addresses = address === '::1' ? [`http://localhost:${port}/`] : address !== '0.0.0.0' && !address.includes(':') ? [`http://${address}:${port}/`] : lanAddresses(port);
        const html = renderEntry(addresses.length ? addresses : [`http://127.0.0.1:${port}/`]);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="Shenru.html"; filename*=UTF-8''${encodeURIComponent('深入·局域网互传.html')}` });
        res.end(method === 'HEAD' ? undefined : html); return;
      }
      if (!path.startsWith('/api/')) {
        requireThat(method === 'GET' || method === 'HEAD', 405, '请求方法不支持');
        const relative = path === '/' ? 'index.html' : decodeURIComponent(path).slice(1);
        const root = join(ROOT, 'public'), file = resolve(root, relative);
        requireThat(file.startsWith(root + sep) && !relative.split(/[\\/]/).some(x => x.startsWith('.')), 404, '页面不存在');
        if(file===join(root,'index.html')) {
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':BOOT_PAGE.length,'Cache-Control':'no-cache'});
          res.end(method==='HEAD'?undefined:BOOT_PAGE);return;
        }
        const handle = await open(file, 'r').catch(() => { throw new HttpError(404, '页面不存在'); });
        const stats = await handle.stat(); if (!stats.isFile()) { await handle.close(); throw new HttpError(404, '页面不存在'); }
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': stats.size, 'Cache-Control': 'no-cache' });
        if (method === 'HEAD') { await handle.close(); res.end(); } else await pipeline(handle.createReadStream(), res); return;
      }
      if (!['GET', 'HEAD'].includes(method)) {
        const origin = req.headers.origin;
        requireThat(!origin || origin === `http://${req.headers.host}`, 403, '不允许其他网页操作这个服务');
        requireThat(!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']), 403, '不允许跨站请求');
      }
      const user = identities.authenticate(req.headers.cookie);
      if (path === '/api/profile' && method === 'POST') {
        const profile = identities.profile((await body(req)).nickname, user);
        if (profile.token) res.setHeader('Set-Cookie', `lan_token=${profile.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
        publish('profile'); json(res, profile.user); return;
      }
      requireThat(user, 401, '请先填写昵称');
      if(path==='/api/keys' && method==='POST') {
        const data=await body(req);requireThat(validPublicKey(data.publicKey),400,'加密公钥无效');
        if(identities.key(user.id)!==data.publicKey){identities.setKey(user.id,data.publicKey);publish('keys');}
        json(res,{publicKey:data.publicKey});return;
      }
      if (path === '/api/state' && method === 'GET') { json(res, snapshot(user)); return; }
      if (path === '/api/ping' && method === 'POST') {
        const data = await body(req);
        if (data.tabId) {
          requireThat(typeof data.tabId === 'string' && /^[\w-]{8,100}$/.test(data.tabId), 400, '标签页标识无效');
          const wasOnline = online(user.id);
          if (!leases.has(user.id)) leases.set(user.id, new Map());
          leases.get(user.id).set(data.tabId, Date.now()); updateDeadlines(); if (!wasOnline) publish('presence');
          json(res, { ok: true }); return;
        }
        const connection = [...(connections.get(user.id) || [])].find(x => x.lanConnectionId === data.connectionId);
        requireThat(connection, 404, '在线连接已断开，正在重新连接');
        connection.lanHeartbeat = Date.now(); json(res, { ok: true }); return;
      }
      if (path === '/api/leave' && method === 'POST') {
        const data = await body(req); leases.get(user.id)?.delete(data.tabId);
        if (!leases.get(user.id)?.size) leases.delete(user.id);
        updateDeadlines(); publish('presence'); json(res, { ok: true }); return;
      }
      if (path === '/api/events' && method === 'GET') {
        // Keep sockets free for messages, heartbeats and large-file requests.
        // Additional tabs use short polling and expiring presence leases.
        if ((connections.get(user.id)?.size || 0) >= 2) { res.writeHead(204); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
        if (!connections.has(user.id)) connections.set(user.id, new Set());
        res.lanConnectionId = randomUUID(); res.lanHeartbeat = Date.now();
        connections.get(user.id).add(res); updateDeadlines();
        const after = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0);
        if (after && after <= seq && after >= (log[0]?.seq || seq) - 1)
          for (const event of log) if (event.seq > after && (!event.conversationId || sessions.get(event.conversationId)?.members.includes(user.id))) res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        res.write(`event: ready\ndata: ${JSON.stringify({ seq, bootId, connectionId: res.lanConnectionId })}\n\n`); publish('presence');
        const ping = setInterval(() => {
          if (Date.now() - res.lanHeartbeat > config.heartbeatTimeoutMs || res.writableLength > 65536) res.destroy();
          else res.write(': heartbeat\n\n');
        }, config.heartbeatMs);
        res.on('close', () => {
          clearInterval(ping); connections.get(user.id)?.delete(res);
          if (!connections.get(user.id)?.size) connections.delete(user.id);
          updateDeadlines(); if (!closing) publish('presence');
        }); return;
      }
      if (path === '/api/friends/requests' && method === 'POST') {
        const request = identities.request(user.id, (await body(req)).code); publish('friends'); json(res, request); return;
      }
      let match;
      if ((match = /^\/api\/friends\/requests\/([^/]+)$/.exec(path)) && method === 'POST') {
        const result = identities.decide(match[1], user.id, (await body(req)).accept);
        if (result.status === 'accepted') conversation(result.sender, result.recipient);
        publish('friends'); json(res, result); return;
      }
      if ((match = /^\/api\/conversations\/([^/]+)\/messages$/.exec(path)) && method === 'POST') {
      const session = access(user, match[1]); const data = await body(req);
        requireThat(!session.closed, 410, '会话已经结束，请重新打开聊天');
        requireThat(typeof data.clientId === 'string' && /^[\w-]{1,100}$/.test(data.clientId), 400, '消息标识无效');
        const key = `${user.id}:${data.clientId}`; const prior = session.dedup.get(key);
        if(prior){requireThat(prior.encrypted ? JSON.stringify(prior.encrypted)===JSON.stringify(data.encrypted) : prior.text===data.text,409,'消息标识冲突');json(res,prior);return;}
        const peerId=session.members.find(id=>id!==user.id);
        const encrypted=data.encrypted ? envelope(data.encrypted,identities.key(user.id),identities.key(peerId)) : null;
        requireThat(encrypted || config.allowPlaintextForTests===true,400,'请刷新网页使用自动加密后再发送');
        if(!encrypted)requireThat(typeof data.text === 'string' && data.text.trim().length > 0 && data.text.length <= 16_000, 400, '消息需要 1–16000 个字符');
        const message = { id: randomUUID(), seq: seq + 1, sender: user.id, ...(encrypted?{encrypted}:{text:data.text}), clientId: data.clientId, time: Date.now() };
        session.messages.push(message); session.dedup.set(key, message); publish('message', session.id); json(res, message); return;
      }
      if (path === '/api/transfers' && method === 'POST') {
        const data = await body(req); const session = access(user, data.conversationId);
        requireThat(data.encryption || config.allowPlaintextForTests===true,400,'请刷新网页使用自动加密后再发送');
        if(data.encryption){
          const prior=[...transfers.items.values()].find(tr=>tr.sender===user.id && tr.clientId===data.clientId && tr.conversationId===session.id);
          requireThat(data.encryption.v===1,400,'加密版本无效');
          data.encryption={v:1,key:envelope(data.encryption.key,prior?.encryption?.key.senderKey || identities.key(user.id),prior?.encryption?.key.recipientKey || identities.key(session.members.find(id=>id!==user.id)),160)};
        }
        const done = activity(user.id);
        try { json(res, await transfers.create(user, session, data)); } finally { done(); } return;
      }
      if ((match = /^\/api\/transfers\/([^/]+)(?:\/(chunks\/(\d+)|complete|download|preview))?$/.exec(path))) {
        const { tr, session } = transferAccess(user, match[1]); const action = match[2];
        if (!action && method === 'GET') { json(res, transfers.view(tr)); return; }
        if ((!action && method === 'DELETE') || (action === 'complete' && method === 'POST') || (match[3] !== undefined && method === 'PUT')) {
          requireThat(tr.sender === user.id, 403, '只有发送者可以修改上传'); const done = activity(user.id);
          try {
            if (!action) json(res, await transfers.cancel(tr));
            else if (action === 'complete') { const completion = await body(req); json(res, await transfers.complete(tr, completion.sha256, completion.elapsedMs, completion.manifest)); }
            else {
              requireThat(uploading < config.maxUploads, 429, '同时上传的文件较多，请稍后重试'); uploading++;
              try { const bytes = await readBody(req, config.chunkSize+(tr.encryption?40:0)); requireThat(!session.closed, 410, '会话已清理'); json(res, await transfers.chunk(tr, Number(match[3]), bytes, req.headers['x-chunk-sha256'],req.headers['x-resume-sha256'])); }
              finally { uploading--; }
            }
          } finally { done(); } return;
        }
        if (['download', 'preview'].includes(action) && ['GET', 'HEAD'].includes(method)) {
          requireThat(tr.status === 'ready', 409, '文件尚未上传完成'); const preview = action === 'preview';
          requireThat(!preview || !tr.encryption,415,'加密原图由接收浏览器解密预览');
          requireThat(!preview || /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(tr.type), 415, '这种图片格式请下载原文件查看');
          let range;
          const downloadSize=tr.wireSize;
          try { range = parseRange(req.headers.range, downloadSize); }
          catch (e) { if (e.status === 416) res.setHeader('Content-Range', `bytes */${downloadSize}`); throw e; }
          const headers = { 'Content-Type': preview ? tr.type : 'application/octet-stream', 'Content-Length': Math.max(0, range.end - range.start + 1),
            'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename="file${tr.encryption?'.shenru-encrypted':''}"; filename*=UTF-8''${encodeURIComponent(tr.name+(tr.encryption?'.shenru-encrypted':'')).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`,
            'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', ETag: `"${tr.sha256}"` };
          if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${downloadSize}`;
          const done = activity(user.id);
          try { res.writeHead(range.partial ? 206 : 200, headers);
            if (!downloadSize || method === 'HEAD') res.end(); else await pipeline(createReadStream(transfers.path(tr), { start: range.start, end: range.end }), res);
          } finally { done(); } return;
        }
      }
      throw new HttpError(404, '接口不存在');
    } catch (e) {
      if (res.headersSent) { if (!res.destroyed) res.destroy(); return; }
      const status = e.status || (e.code === 'ENOSPC' ? 507 : e.code === 'ENOENT' ? 404 : 500);
      if (status === 500) console.error('请求处理失败:', e.stack || e.message);
      json(res, { error: status === 500 ? '服务处理失败，请稍后重试' : e.message }, status);
    }
  });
  server.requestTimeout = 0; server.headersTimeout = 60_000;
  async function sweep() {
    if (sweepRunning || closing) return; sweepRunning = true;
    try {
      for (const [id, tabs] of leases) {
        for (const [tab, at] of tabs) if (Date.now() - at >= config.heartbeatTimeoutMs) tabs.delete(tab);
        if (!tabs.size) leases.delete(id);
      }
      updateDeadlines();
      for (const session of sessions.values()) if (session.closed || (session.offlineAt !== null && Date.now() - session.offlineAt >= config.graceMs)) {
        session.closed = true;
        try { await transfers.clearConversation(session.id); sessions.delete(session.id); if (pairs.get(session.key) === session) pairs.delete(session.key); publish('expired', session.id); }
        catch (e) { console.error('旧会话已结束，临时文件清理失败，将独立重试:', e.message); }
      }
    } finally { sweepRunning = false; }
  }
  const timer = setInterval(sweep, config.sweepMs); timer.unref();
  return { server, serviceInfo,
    async start() { await new Promise((ok, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => { server.removeListener('error', reject); ok(); }); }); },
    async close() {
      if (closed) return; closed = true; closing = true; clearInterval(timer);
      for (const set of connections.values()) for (const res of set) res.end();
      if (server.listening) { const stopped = new Promise(r => server.close(r)); server.closeAllConnections(); await stopped; }
      while (sweepRunning) await new Promise(r => setTimeout(r, 10));
      await Promise.all([...sessions.keys()].map(id => transfers.clearConversation(id))).catch(e => console.error('退出清理:', e.message));
      identities.close(); await unlock();
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let app;
  try {
    const number = (name, fallback) => process.env[name] === undefined ? fallback : Number(process.env[name]);
    app = await createApp({ port: number('PORT', 3000), host: process.env.HOST || '0.0.0.0', dataDir: process.env.LAN_DATA_DIR || join(ROOT, '.data'),
      quotaBytes: number('LAN_QUOTA_BYTES', CONFIG.quotaBytes), reserveBytes: number('LAN_RESERVE_BYTES', CONFIG.reserveBytes), graceMs: number('LAN_GRACE_MS', CONFIG.graceMs) });
    await app.start(); const port = app.server.address().port;
    console.log(`\n  深入·局域网互传\n\n  本机：http://localhost:${port}`);
    const interfaces = Object.entries(networkInterfaces()).flatMap(([name, list]) => (list || []).map(net => ({ ...net, name })))
      .filter(net => net.family === 'IPv4' && !net.internal);
    const privateIP = ip => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
    interfaces.sort((a, b) => Number(privateIP(b.address)) - Number(privateIP(a.address)));
    for (const net of interfaces) console.log(`  局域网：http://${net.address}:${port} (${net.name})`);
    console.log('\n  让另一台设备打开同一个局域网网址。双方应使用相同地址。\n  保持此窗口运行；按 Ctrl+C 关闭服务。\n');
    if (process.argv.includes('--open') && !process.argv.includes('--no-open') && process.platform === 'win32') {
      const opener = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', `http://localhost:${port}`], { windowsHide: true, stdio: 'ignore' });
      opener.on('error', () => console.log('请在浏览器手动打开上面的本机网址。')); opener.unref();
    }
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (e) {
    console.error(e.code === 'EADDRINUSE' ? '端口被占用。请关闭原服务，或在 config.cmd 中更换 PORT。' : e.message);
    await app?.close(); process.exitCode = 1;
  }
}
