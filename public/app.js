import { withRetry } from './retry.js';
import { characterFor } from './avatars.js';
import { verifiedBlob, BUFFERED_DOWNLOAD_LIMIT, checkDownloadResponse } from './download-core.js';
import { contactSections } from './contacts.js';
import { TransferMeter, formatDuration, formatRate, formatRemaining } from './transfer-metrics.js';
import { CompletionNotifier } from './completion-notifications.js';
import { installComposerResize } from './composer-resize.js';
import { loadIdentity } from './crypto-storage.js';
import { sealForPeer, openFromPeer, messageContext, fileContext, randomBytes, bytesToHex } from './content-crypto.js';
import { decryptedBlob } from './encrypted-download.js';
import { DownloadHistory, downloadSelection, retryDownloadSelection, runDownloadQueue, downloadControlState } from './download-history.js';
import { atConversationEnd,conversationEndSeq,unreadConversationCount,ChatScrollIntent } from './chat-attention.js';
const $ = id => document.getElementById(id);
installComposerResize({handle:$('composer-resizer'),textarea:$('message-input'),composer:$('composer'),messages:$('messages'),chat:$('chat')});
const uid = () => [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, '0')).join('');
function node(tag, className, text) { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; }
function icon(name) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', `#i-${name}`); svg.append(use); return svg; }
function button(text, action, className = '') { const item = node('button', className, text); item.type = 'button'; item.addEventListener('click', action); return item; }
function paintAvatar(element, person) {
  const path = characterFor(person);
  if (element.dataset.character === path) return;
  const image = node('img', 'character-image'); image.src = path; image.alt = ''; image.width = 96; image.height = 96; image.draggable = false;
  element.replaceChildren(image); element.dataset.character = path;
}
function avatar(person) { const element = node('div', 'avatar'); paintAvatar(element, person); return element; }
function size(bytes) { if (bytes < 1000) return `${bytes} B`; const unit = ['KB', 'MB', 'GB']; let n = bytes / 1000, i = 0; while (n >= 1000 && i < 2) { n /= 1000; i++; } return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} ${unit[i]}`; }
function time(ts) { return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
let toastTimer;
let activeDownload = null, lastDownloadPaint = 0;
let batchDownload = null, batchErrorPeer = null;
let contentIdentity;
const previewCache = new Map();
function downloadLabel() {
  if(!activeDownload)return '';
  const percent=Math.min(100,Math.floor(activeDownload.bytes/Math.max(1,activeDownload.total)*100));
  return activeDownload.phase==='preparing'?'正在准备下载…':activeDownload.phase==='cancelling'?'正在取消下载…':`${activeDownload.phase==='verifying'?'正在校验原文件':'正在下载并解密'} · ${percent}%`;
}
function syncDownloadUI(force=true) {
  if(!force && Date.now()-lastDownloadPaint<180)return;lastDownloadPaint=Date.now();
  const label=downloadLabel(),notice=$('download-notice'),preview=$('preview-dialog');
  if(preview.open && notice.parentNode!==preview)preview.append(notice);
  else if(!preview.open){
    const sidebar=document.querySelector('.sidebar');
    if(matchMedia('(max-width:720px)').matches && !$('app').classList.contains('chat-open')){
      if(notice.parentNode!==sidebar)sidebar.insertBefore(notice,sidebar.querySelector('.search-box'));
    }else if(notice.parentNode!==document.body)document.body.append(notice);
  }
  notice.hidden=!activeDownload && !batchDownload;
  $('download-notice-label').textContent=activeDownload ? `${batchDownload?`批量 ${batchDownload.index}/${batchDownload.total} · `:''}${label} · ${activeDownload.name}` : batchDownload ? '正在准备下一份文件…' : '';
  $('cancel-download').textContent=batchDownload?'停止批量下载':'取消下载';
  $('cancel-download').disabled=activeDownload?.phase==='cancelling' || !!batchDownload?.controller.signal.aborted;
  const transfers=new Map((state?.conversations||[]).flatMap(conv=>conv.transfers).map(tr=>[tr.id,tr]));
  for(const control of document.querySelectorAll('[data-download-id]')) {
    const busy=activeDownload?.id===control.dataset.downloadId;
    const tr=transfers.get(control.dataset.downloadId),downloaded=!!tr&&downloadHistory.has(downloadScope(),tr);
    const presentation=downloadControlState({downloaded,busy:!!activeDownload||!!batchDownload,ready:tr?.status==='ready'&&control.dataset.downloadReady!=='false',kind:control.dataset.downloadKind||'list'});
    control.setAttribute('aria-label',`${presentation.label}${tr?`：${tr.name}`:''}${busy?`（${label}）`:''}`);
    control.setAttribute('aria-busy',String(!!busy));control.setAttribute('aria-disabled',String(presentation.disabled));
    if(control.tagName==='BUTTON')control.disabled=presentation.disabled;
    control.hidden=presentation.hidden;
    control.classList.toggle('is-downloaded',downloaded);
    const text=control.querySelector('[data-download-text]');if(text)text.textContent=presentation.label;
    control.title=downloaded?'已向浏览器发起保存；若未保存成功，可点击重新下载':control.dataset.downloadReady==='false'?'文件尚未就绪':presentation.label;
  }
  for(const status of document.querySelectorAll('[data-download-status]')){
    const tr=transfers.get(status.dataset.downloadStatus),downloaded=!!tr&&downloadHistory.has(downloadScope(),tr);
    status.textContent=activeDownload?.id===status.dataset.downloadStatus?label:downloaded?'已校验 · 已下载':status.dataset.baseStatus;
  }
  for(const bar of document.querySelectorAll('[data-download-progress]')){
    const running=activeDownload?.id===bar.dataset.downloadProgress;bar.hidden=!running;
    if(running)bar.querySelector('progress').value=activeDownload.bytes/Math.max(1,activeDownload.total);
  }
  for(const subtitle of document.querySelectorAll('[data-download-subtitle]')){
    const tr=transfers.get(subtitle.dataset.downloadSubtitle),downloaded=!!tr&&downloadHistory.has(downloadScope(),tr);
    subtitle.textContent=activeDownload?.id===subtitle.dataset.downloadSubtitle?label:subtitle.dataset.baseStatus+(downloaded?' · 已下载':'');
    subtitle.closest('.file-list-item')?.classList.toggle('is-downloaded',downloaded);
  }
  syncBatchDownloadUI();
}
$('cancel-download').addEventListener('click',()=>{batchDownload?.controller.abort();if(activeDownload){activeDownload.phase='cancelling';activeDownload.controller.abort();}syncDownloadUI();});
$('preview-dialog').addEventListener('close',()=>syncDownloadUI());
window.addEventListener('resize',()=>syncDownloadUI());
function fileSecret(tr) {
  if(!contentIdentity || !tr.encryption)throw Error('加密连接尚未就绪，请刷新后重试');
  const secret=openFromPeer(contentIdentity,tr.encryption.key,['file-key',fileContext(tr)]);
  if(!/^[a-f0-9]{64}$/.test(secret))throw Error('文件密钥无效，无法下载');return secret;
}
async function decodeSnapshot(next) {
  if(next.config.contentEncryption!==1)throw Error('主机需要更新到支持自动加密的版本');
  contentIdentity=await loadIdentity(next.me.id);
  if(next.me.encryptionKey!==contentIdentity.publicKey){await api('/api/keys',{publicKey:contentIdentity.publicKey});next.me.encryptionKey=contentIdentity.publicKey;}
  for(const conv of next.conversations)for(const message of conv.messages) {
    try {
      if(!message.encrypted)throw Error('明文消息已拒绝');
      message.text=openFromPeer(contentIdentity,message.encrypted,messageContext(conv.id,message.sender,message.clientId));
      if(message.text.length>16000)throw Error('消息过长');
    } catch {message.text='此消息无法解密，浏览器密钥可能已清除或变化';}
  }
  const active=new Set(next.conversations.flatMap(c=>c.transfers.map(tr=>tr.id)));
  for(const [id,item] of previewCache)if(!active.has(id)){if(item.url)URL.revokeObjectURL(item.url);item.expired=true;previewCache.delete(id);}
  return next;
}
function previewUrl(tr) {
  const existing=previewCache.get(tr.id);if(existing)return existing.promise;
  const item={};previewCache.set(tr.id,item);
  item.promise=(async()=>{
    const controller=new AbortController();let timer;
    const progress=()=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(),120000);};progress();
    try {
      const response=await fetch(`/api/transfers/${tr.id}/download`,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
      const blob=await decryptedBlob(response,tr,fileSecret(tr),progress);
      item.url=URL.createObjectURL(blob);
      if(item.expired){URL.revokeObjectURL(item.url);throw Error('会话已清理');}
      return item.url;
    } catch(error){previewCache.delete(tr.id);throw error;}finally{clearTimeout(timer);}
  })();return item.promise;
}
const previewObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){previewObserver.unobserve(entry.target);entry.target.loadEncryptedPreview?.();}},{rootMargin:'150px'});
async function downloadFile(tr, {batch=false,scope=downloadScope()}={}) {
  if (activeDownload || (batchDownload&&!batch)) { toast('已有文件正在下载校验，请稍候'); return 'busy'; }
  const controller = new AbortController(); let idleTimer;
  activeDownload={id:tr.id,name:tr.name,controller,phase:'preparing',bytes:0,total:tr.size};syncDownloadUI();
  const progress = received => {
    clearTimeout(idleTimer);idleTimer=setTimeout(()=>controller.abort(),120000);
    if(Number.isFinite(received) && activeDownload && !['verifying','cancelling'].includes(activeDownload.phase)){
      activeDownload.phase='decrypting';activeDownload.bytes=Math.min(tr.size,Math.floor(tr.size*received/Math.max(1,tr.wireSize||tr.size)));syncDownloadUI(false);
    }
  };
  progress();
  try {
    const path = `/api/transfers/${tr.id}/download`;
    const metadata = await api(`/api/transfers/${tr.id}`,undefined,'GET',controller.signal);
    if (metadata.status !== 'ready' || metadata.sha256 !== tr.sha256 || metadata.size !== tr.size) throw Error('文件状态已变化，请刷新后重新下载');
    let href = path, objectUrl;
    if(tr.encryption) {
      const response=await fetch(path,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
      const blob=await decryptedBlob(response,metadata,fileSecret(metadata),progress,{signal:controller.signal,onState(status){
        if(!activeDownload||activeDownload.phase==='cancelling')return;
        const changed=activeDownload.phase!==status.phase;Object.assign(activeDownload,status);syncDownloadUI(changed);
      }});
      if(controller.signal.aborted)throw new DOMException('下载已取消','AbortError');
      objectUrl=href=URL.createObjectURL(new Blob([blob],{type:'application/octet-stream'}));
    } else if (tr.size <= BUFFERED_DOWNLOAD_LIMIT) {
      toast('正在下载并校验原文件…');
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      objectUrl = href = URL.createObjectURL(await verifiedBlob(response, tr, progress));
    } else {
      const response = await fetch(path, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      checkDownloadResponse(response, tr);
    }
    if(controller.signal.aborted)throw new DOMException('下载已取消','AbortError');
    const link = node('a'); link.href = href; link.download = tr.name; document.body.append(link); link.click(); link.remove();
    downloadHistory.mark(scope,tr);
    if (objectUrl) { setTimeout(() => URL.revokeObjectURL(objectUrl), 60000); toast('完整性校验通过，已交给浏览器保存'); }
    else toast('已交给浏览器流式下载，请在下载列表确认完成');
    return 'success';
  } catch (error) { const cancelled=error.name==='AbortError' && activeDownload?.phase==='cancelling';toast(error.name === 'AbortError' ? (cancelled?'已取消下载':'下载连接长时间没有响应，请重试') : error.message || '下载失败，请重新尝试');return cancelled?'cancelled':'error'; }
  finally { clearTimeout(idleTimer); activeDownload = null; syncDownloadUI(); }
}
function toast(text, action) {
  const target = $('toast'); target.replaceChildren(document.createTextNode(text));
  if (action) target.append(button('查看文件', action, 'toast-action'));
  target.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { target.hidden = true; }, action ? 12000 : 4000);
}
function storage(name) { try { return window[name]; } catch { return undefined; } }
const downloadHistory=new DownloadHistory(storage('localStorage'));
function downloadScope(){return {bootId:state?.bootId,meId:state?.me.id};}
function syncBatchDownloadUI(){
  const control=$('batch-download'),hint=$('batch-download-hint'),retry=$('batch-download-retry');
  const conv=selectedConversation(),scope=downloadScope(),selection=downloadSelection(conv,scope,downloadHistory);
  const replay=retryDownloadSelection(conv,scope,downloadHistory);
  control.hidden=!selection.visible;hint.hidden=!selection.visible;retry.hidden=!selection.visible||!replay.items.length;
  retry.textContent=replay.legacy?'重新下载已记录文件':'重新下载本批';
  retry.disabled=!!activeDownload||!!batchDownload;
  if(!selection.visible)return;
  const running=batchDownload?.peerId===currentPeer;
  const label=running?`正在下载 ${batchDownload.index}/${batchDownload.total}`:selection.pending.length?`下载未下载文件（${selection.pending.length}）`:selection.waiting?'等待文件就绪':'已发起保存';
  $('batch-download-label').textContent=label;
  control.disabled=!!activeDownload||!!batchDownload||!selection.pending.length;
  control.setAttribute('aria-busy',String(!!running));
  control.dataset.state=running?'loading':batchErrorPeer===currentPeer&&selection.pending.length?'error':!selection.pending.length&&!selection.waiting?'success':control.disabled?'disabled':'default';
  hint.textContent=!downloadHistory.persistent?'下载记录仅在本页有效，刷新后可能重复下载':batchErrorPeer===currentPeer&&selection.pending.length?'部分文件未完成，可点击重试':selection.waiting?`还有 ${selection.waiting} 份文件正在上传`:!selection.pending.length?'已发起保存，请确认浏览器下载列表':'首次使用请允许浏览器下载多个文件';
  control.title='仅跳过本浏览器已校验并发起保存的文件；若浏览器拦截或保存被取消，可重新下载本批';
}
async function startBatchDownload(replay=false){
  if(activeDownload||batchDownload)return;
  const scope=downloadScope(),conv=selectedConversation(),selection=downloadSelection(conv,scope,downloadHistory);
  const items=replay?retryDownloadSelection(conv,scope,downloadHistory).items:selection.pending;
  if(!items.length)return;
  downloadHistory.rememberBatch(scope,conv,items);
  const job=batchDownload={peerId:currentPeer,index:1,total:items.length,controller:new AbortController()};batchErrorPeer=null;syncDownloadUI();
  toast('将逐个保存原文件；若浏览器询问，请允许下载多个文件');
  try{
    const result=await runDownloadQueue({items,signal:job.controller.signal,onProgress(progress){job.index=progress.index;syncDownloadUI();},download(tr){if(scope.bootId!==state?.bootId||scope.meId!==state?.me.id){job.controller.abort();return 'cancelled';}return downloadFile(tr,{batch:true,scope});}});
    if(result.failed)batchErrorPeer=job.peerId;
    toast(result.cancelled?`已停止，已发起 ${result.success} 份下载，其余可稍后继续`:result.failed?`已发起 ${result.success} 份下载，${result.failed} 份未完成，可重试`:`${result.success} 份原文件已校验；请允许浏览器下载多个文件，并在下载列表确认保存`);
  }finally{batchDownload=null;syncDownloadUI();}
}
$('batch-download').addEventListener('click',()=>startBatchDownload());
$('batch-download-retry').addEventListener('click',()=>startBatchDownload(true));
window.addEventListener('storage',event=>{if(event.key===null||event.key.startsWith('shenru-downloaded:v1:')||event.key.startsWith('shenru-download-batch:v1:'))syncDownloadUI();});
const metricStorage = storage('sessionStorage');
const completionNotices = new CompletionNotifier({ NotificationClass: window.Notification, secure: window.isSecureContext,
  preferences: storage('localStorage'), session: metricStorage });
function metricKey(id) { return `shenru-meter:${state?.bootId}:${id}`; }
function ensureMeter(job) {
  if (job.meter) return job.meter;
  let saved; try { saved = JSON.parse(metricStorage?.getItem(metricKey(job.id)) || '{}'); } catch {}
  return job.meter = new TransferMeter(saved || {});
}
function saveMeter(job, force = false) {
  if (!job.meter || (!force && Date.now() - (job.savedAt || 0) < 1000)) return;
  job.savedAt = Date.now(); try { metricStorage?.setItem(metricKey(job.id), JSON.stringify(job.meter.snapshot())); } catch {}
}
function transferMetrics(tr, job) {
  const elapsed = tr.elapsedMs ?? job?.tr?.elapsedMs;
  if (tr.status === 'ready') return Number.isFinite(elapsed) ? [
    ['平均速度', elapsed > 0 ? formatRate(tr.size * 1000 / elapsed) : '—'], ['总耗时', formatDuration(elapsed)], ['校验', '已通过']
  ] : null;
  if (!job || tr.status === 'cancelled') return null;
  const stats = ensureMeter(job).stats(tr.size);
  const verifying = job.phase === 'verifying', running = job.running && !verifying;
  const remaining = verifying ? '校验中' : job.status === 'paused' ? '已暂停' : job.status === 'error' ? '待继续' : job.status === 'queued' ? '等待上传' : formatRemaining(stats.remainingSeconds);
  return [['实时速度', running ? formatRate(stats.rate) : '—'], ['已用时间', formatDuration(stats.elapsedMs)], ['预计剩余', remaining]];
}
async function revealTransfer(tr, { keepFileList = false } = {}) {
  try {
    await refresh(); const conv = state?.conversations.find(item => item.id === tr.conversationId);
    if (!conv || !conv.transfers.some(item => item.id === tr.id)) { toast('本次文件已随会话清理'); return; }
    if (!keepFileList) switchView('chats');
    openChat(conv.peerId);
    requestAnimationFrame(() => {
      const row = document.getElementById(`transfer-${tr.id}`), card = row?.querySelector('.file-card');
      scrollIntent.locate();row?.scrollIntoView({ block: 'center', behavior: 'smooth' }); card?.focus({ preventScroll: true });
      document.querySelectorAll('.file-located').forEach(item => item.classList.remove('file-located'));
      if (card) { card.classList.add('file-located'); setTimeout(() => card.classList.remove('file-located'), 2400); }
    });
  } catch { toast('暂时无法打开文件，请稍后重试'); }
}
function announceCompletion(job) {
  const open = () => { try { window.focus(); } catch {} revealTransfer(job.tr); };
  if (completionNotices.complete(job.tr, `${state.bootId}:${job.id}`, open)) toast(`${job.tr.name} · 上传完成，已通过校验`, open);
}
async function finishJob(job) {
  ensureMeter(job).pause();
  if (Number.isFinite(job.tr.elapsedMs)) job.meter.elapsed = job.tr.elapsedMs;
  saveMeter(job, true); job.status = 'ready'; job.running = false; job.phase = 'ready'; job.label = '上传完成';
  await refresh(); announceCompletion(job);
}
function updateReminderControl() {
  const control = $('completion-reminder-button'), note = $('completion-reminder-note');
  control.textContent = completionNotices.enabled ? '系统完成提醒已开启 · 点击关闭' : completionNotices.supported ? '开启系统完成提醒' : '页面完成提醒已开启';
  control.setAttribute('aria-pressed', String(completionNotices.enabled));
  note.textContent = !completionNotices.supported ? '当前地址或浏览器不支持系统通知。上传校验通过后，页面内仍会显示可点击的完成提醒。' : completionNotices.permission === 'denied' ? '浏览器已阻止通知。你可以在地址栏的网站设置中允许通知；页面内提醒仍可使用。' : '点击开启后由浏览器请求授权。上传并校验成功后提醒一次，点击通知回到文件卡片。';
}
async function api(path, body, method = body === undefined ? 'GET' : 'POST', signal) {
  const controller = new AbortController(); let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
  try {
    const res = await fetch(path, { method, signal: controller.signal, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json(); if (!res.ok) { const error = new Error(data.error || '请求失败'); error.status = res.status; throw error; } return data;
  } catch (error) { if (timedOut) throw new Error('请求超时，正在等待网络恢复'); throw error; }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
let state, currentPeer = null, view = 'chats', events, heartbeatTimer, pollTimer, connected = false, refreshing = false, dirty = false, resumeTarget = null;
const tabId = uid();
const seen = new Map(), drafts = new Map(), pending = new Map(), jobs = new Map(), rowCache = new Map();
const scrollIntent=new ChatScrollIntent();
function selectedConversation() { return state?.conversations.find(x => x.peerId === currentPeer); }
function friendById(id) { return state?.friends.find(x => x.id === id); }
async function refresh() {
  dirty = true; if (refreshing) return; refreshing = true;
  try {
    while (dirty) {
      dirty = false; const next = await api('/api/state');
      if (state && state.bootId !== next.bootId) {
        for (const job of jobs.values()) stopJob(job, 'error', '服务已重启，请重新发送');
        pending.clear(); rowCache.clear(); seen.clear();scrollIntent.reset();toast('服务已重启：好友保留，本次聊天和临时文件已清理');
      }
      state = await decodeSnapshot(next);
      if (currentPeer && !friendById(currentPeer)) currentPeer = null;
      for (const [id, job] of jobs) {
        const remote = state.conversations.flatMap(c => c.transfers).find(x => x.id === id);
        if (!remote && !job.running) jobs.delete(id);
      }
      paintAvatar($('profile-button'), state.me); paintAvatar($('workspace-avatar'), state.me); $('my-code').textContent = state.me.code;
      $('workspace-nickname').textContent = state.me.nickname;
      $('online-count').textContent = state.online.length;
      $('transfer-count').textContent = state.conversations.reduce((count, conversation) => count + conversation.transfers.length, 0);
      render();
    }
  } catch (error) {
    if (error.status === 401) { clearInterval(pollTimer); pollTimer = null; events?.close(); events = null; if (!$('identity-dialog').open) $('identity-dialog').showModal(); }
    else { connected = false; updateConnection(); if(error.message && !/fetch|网络|超时/i.test(error.message))toast(error.message); }
  } finally { refreshing = false; }
}
function connect() {
  if (events) return;
  const source = events = new EventSource('/api/events');
  source.addEventListener('ready', event => {
    const { connectionId } = JSON.parse(event.data);
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => { api('/api/ping', { connectionId }).catch(() => {}); }, 15000);
    connected = true; updateConnection(); refresh();
  });
  source.onmessage = () => refresh();
  source.onerror = () => {
    clearInterval(heartbeatTimer); source.close(); if (events === source) events = null;
    connected = false; updateConnection(); startPolling();
  };
}
function startPolling() {
  if (pollTimer) return;
  let syncing = false;
  const sync = async () => {
    if (syncing) return; syncing = true;
    try { await api('/api/ping', { tabId }); connected = true; updateConnection(); await refresh(); }
    catch (error) { connected = false; updateConnection(); if (error.status === 401) refresh(); }
    finally { syncing = false; }
  };
  pollTimer = setInterval(sync, 3000); sync();
}
function updateConnection() {
  $('connection-text').textContent = connected ? (pollTimer ? '已连接 · 兼容模式' : '局域网已连接') : '正在重新连接…';
  $('connection-dot').classList.toggle('offline', !connected);
  const pill = document.querySelector('.local-pill'); pill.replaceChildren(node('span', `status-dot${connected ? '' : ' offline'}`), document.createTextNode(connected ? '本地连接' : '正在重连'));
}
function switchView(next) {
  view = next === 'nearby' ? 'chats' : next; $('app').classList.remove('chat-open');
  document.querySelectorAll('[data-view]').forEach(el => {
    const active = el.dataset.view === view;
    el.classList.toggle('active', active); el.setAttribute('aria-pressed', String(active));
  });
  $('search').placeholder = view === 'files' ? '搜索文件' : '搜索好友或在线邻居';
  $('search').value = ''; renderSidebar();
}
function openChat(peerId) {
  if (currentPeer) drafts.set(currentPeer, $('message-input').value);
  currentPeer = peerId; $('message-input').value = drafts.get(peerId) || ''; rowCache.clear();scrollIntent.reset();
  const conv=selectedConversation();if(conv)seen.set(conv.id,conversationEndSeq(conv));
  $('app').classList.add('chat-open'); render();
  requestAnimationFrame(() => { $('messages').scrollTo({top:$('messages').scrollHeight,behavior:'instant'});syncNewMessageHint(); });
}
function setRead(conv) {
  const visible = !matchMedia('(max-width:720px)').matches || $('app').classList.contains('chat-open');
  if (conv && visible && document.visibilityState === 'visible' && atConversationEnd($('messages'))) {seen.set(conv.id,conversationEndSeq(conv));scrollIntent.arrived();}
}
function syncNewMessageHint(){
  const conv=selectedConversation(),control=$('new-messages'),count=unreadConversationCount(conv,state?.me.id,seen.get(conv?.id)||0);
  control.hidden=!conv||!count||!currentPeer;
  const label=`您有 ${count} 条新消息`;
  if($('new-messages-label').textContent!==label)$('new-messages-label').textContent=label;
  control.setAttribute('aria-label',`${label}，点击查看最新消息`);
}
$('messages').addEventListener('scroll',()=>{const conv=selectedConversation(),before=seen.get(conv?.id);setRead(conv);syncNewMessageHint();if(conv&&before!==seen.get(conv.id))renderSidebar();},{passive:true});
for(const event of ['wheel','touchstart','pointerdown'])$('messages').addEventListener(event,()=>{scrollIntent.interrupt();},{passive:true});
$('messages').addEventListener('keydown',()=>{scrollIntent.interrupt();});
$('new-messages').addEventListener('click',()=>{scrollIntent.jump();$('messages').scrollTo({top:$('messages').scrollHeight,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});});
function emptyList(text, cta) {
  const wrap = node('div', 'sidebar-empty'); wrap.append(icon(view === 'files' ? 'file' : 'people'), node('p', '', text));
  if (cta) wrap.append(button('通过好友码添加 →', () => $('add-button').click())); return wrap;
}
function requestRow(request) {
  const wrap = node('div', 'contact-row'); wrap.append(avatar({ id: request.sender === state.me.id ? request.recipient : request.sender, nickname: request.nickname }));
  const info = node('div', 'contact-info'); info.append(node('strong', '', request.nickname));
  if (request.recipient === state.me.id) {
    info.append(node('p', '', '想和你成为好友')); const actions = node('div', 'request-actions');
    for (const [label, accept] of [['接受', true], ['忽略', false]]) actions.append(button(label, async () => {
      try { await api(`/api/friends/requests/${request.id}`, { accept }); await refresh(); toast(accept ? '已成为好友，可以开始聊天了' : '已忽略申请'); } catch (e) { toast(e.message); }
    }, `small-button${accept ? '' : ' reject'}`)); info.append(actions);
  } else info.append(node('p', '', '好友申请已发送，等待对方同意'));
  wrap.append(info); return wrap;
}
function nearbyRows(container, query = '', people = state.online.filter(x => !friendById(x.id) && x.nickname.toLowerCase().includes(query))) {
  let count = 0;
  for (const person of people) {
    count++; const wrap = node('div', 'contact-row'); wrap.append(avatar(person));
    const info = node('div', 'contact-info'); info.append(node('strong', '', person.nickname), node('p', '', `在线 · ${person.code}`)); wrap.append(info);
    const hasRequest = state.requests.some(r => [r.sender, r.recipient].includes(person.id));
    wrap.append(button(hasRequest ? '已申请' : '添加', () => sendRequest(person.code), 'small-button'));
    wrap.lastChild.disabled = hasRequest; container.append(wrap);
  }
  return count;
}
function renderSidebar() {
  if (!state) return;
  const list = $('contact-list'); list.replaceChildren(); const query = $('search').value.toLowerCase().trim();
  $('request-dot').hidden = !state.requests.some(x => x.recipient === state.me.id);
  if (view === 'chats') {
    const { friends, requests, neighbors } = contactSections(state, query);
    $('list-title').textContent = '我的好友';
    $('list-count').textContent = String(friends.length).padStart(2, '0');
    if (requests.length) {
      const title = node('h2', 'contact-group-title', `好友申请 · ${requests.length}`); list.append(title);
      for (const request of requests) list.append(requestRow(request));
      list.append(node('h2', 'contact-group-title', '已添加的好友'));
    }
    for (const friend of friends) {
      const conv = state.conversations.find(x => x.peerId === friend.id);
      const row = button('', () => openChat(friend.id), `contact-row${currentPeer === friend.id ? ' selected' : ''}`);
      const image = avatar(friend); if (friend.online) image.append(node('i', 'online-indicator')); row.append(image);
      const info = node('div', 'contact-info'), latest = conv?.messages.at(-1), file = conv?.transfers.at(-1);
      const summary = file && (!latest || file.seq > latest.seq) ? '[文件] ' + file.name : latest?.text || '开始聊天';
      info.append(node('strong', '', friend.nickname), node('p', '', summary)); row.append(info);
      const unread = [...(conv?.messages || []), ...(conv?.transfers || [])].filter(x => x.sender !== state.me.id && x.seq > (seen.get(conv.id) || 0)).length;
      if (unread) row.append(node('span', 'unread', unread > 99 ? '99+' : unread)); list.append(row);
    }
    if (!friends.length && !query) list.append(node('p', 'contact-group-empty', '还没有好友，可从下方在线邻居中添加。'));
    if (!friends.length && query && !requests.length && !neighbors.length) list.append(emptyList('没有找到匹配的好友或邻居'));
    const neighborsTitle = node('h2', 'contact-group-title'); neighborsTitle.id = 'online-neighbors'; neighborsTitle.tabIndex = -1;
    neighborsTitle.append(node('span', '', '在线邻居'), node('span', '', String(neighbors.length).padStart(2, '0'))); list.append(neighborsTitle);
    nearbyRows(list, query, neighbors);
    if (!neighbors.length) list.append(node('p', 'contact-group-empty', query ? '没有匹配的在线邻居。' : '朋友打开同一个空间后，会自动出现在这里。'));
  } else {
    $('list-title').textContent = '本次会话的文件'; let count = 0;
    for (const conv of state.conversations) for (const tr of conv.transfers) {
      if (!tr.name.toLowerCase().includes(query)) continue; count++;
      const row = node('div', 'file-list-item full-width'); row.dataset.transferId = tr.id;
      const locate = button('', () => revealTransfer(tr, { keepFileList: true }), 'file-list-open');
      locate.setAttribute('aria-label', `定位文件：${tr.name}`); locate.title = '在聊天中定位这份文件';
      const subtitle=node('p','',`${size(tr.size)} · ${friendById(conv.peerId)?.nickname} · ${tr.status === 'ready' ? '原文件已就绪' : tr.status === 'cancelled' ? '已取消' : '等待上传完成'}`);
      subtitle.dataset.downloadSubtitle=tr.id;subtitle.dataset.baseStatus=subtitle.textContent;
      locate.append(node('div', 'file-name', tr.name), subtitle);
      const download = button('', event => { event.stopPropagation(); downloadFile(tr); }, 'file-list-download icon-button');
      download.append(icon('download')); download.disabled = tr.status !== 'ready';
      download.dataset.downloadId=tr.id;download.dataset.downloadReady=String(tr.status==='ready');
      download.setAttribute('aria-label', `下载原文件：${tr.name}`);
      download.title = tr.status === 'ready' ? '下载原文件' : tr.status === 'cancelled' ? '文件已取消，无法下载' : '上传完成后可下载';
      row.append(locate, download); list.append(row);
    }
    $('list-count').textContent = String(count).padStart(2, '0'); if (!count) list.append(emptyList('还没有传输文件。\n打开聊天，分享第一份原文件。'));
  }
  $('dialog-nearby').replaceChildren(); if (!nearbyRows($('dialog-nearby'))) $('dialog-nearby').append(node('p', 'sidebar-empty', '朋友打开同一个网址后，会出现在这里。'));
  syncDownloadUI();
}
function render() {
  if (!state) return;
  const peer = friendById(currentPeer), conv = selectedConversation(); setRead(conv); renderSidebar();
  $('welcome').hidden = !!peer; $('chat').hidden = !peer; document.querySelector('.topbar').hidden = !!peer;
  if (!peer || !conv) {$('new-messages').hidden=true;return;}
  $('peer-name').textContent = peer.nickname; $('peer-status').textContent = peer.online ? '在线' : '离线 · 消息保留在本次会话';
  paintAvatar($('peer-avatar'), peer); renderMessages(conv);syncDownloadUI();syncNewMessageHint();
}
function messageRow(message, failed) {
  const mine = message.sender === state.me.id; const row = node('div', `message-row${mine ? ' mine' : ''}`);
  row.append(avatar(mine ? state.me : friendById(message.sender)));
  const content = node('div', 'message-content'); content.append(node('div', 'bubble', message.text));
  const meta = node('div', 'message-meta', `${time(message.time)}${failed ? '' : mine ? ' · 已发送' : ''}`);
  if (failed) meta.append(button(message.sending ? '发送中…' : '发送失败，点击重试', () => submitMessage(message), 'retry-message'));
  content.append(meta); row.append(content); return row;
}
function fileRow(tr) {
  const mine = tr.sender === state.me.id, job = jobs.get(tr.id);
  const row = node('div', `message-row${mine ? ' mine' : ''}`); row.id = `transfer-${tr.id}`; row.append(avatar(mine ? state.me : friendById(tr.sender)));
  const content = node('div', 'message-content'); const card = node('div', 'file-card'); card.tabIndex = -1;
  if (tr.status === 'ready' && /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(tr.type)) {
    const img = node('img', 'image-preview'); img.alt = tr.name; img.loading = 'lazy';
    img.addEventListener('load',()=>{if(selectedConversation()?.id===tr.conversationId && scrollIntent.following){$('messages').scrollTo({top:$('messages').scrollHeight,behavior:scrollIntent.jumping&&!matchMedia('(prefers-reduced-motion: reduce)').matches?'smooth':'instant'});}});
    if(tr.encryption){img.loadEncryptedPreview=()=>{previewUrl(tr).then(url=>{img.src=url;}).catch(()=>{img.dispatchEvent(new Event('error'));});};previewObserver.observe(img);}else img.src = `/api/transfers/${tr.id}/preview`;
    const previewButton=button('',async()=>{
      try {
        const source=tr.encryption ? await previewUrl(tr) : img.src;
        $('preview-image').src=source;for(const id of ['preview-download','preview-download-again']){const download=$(id);download.dataset.downloadId=tr.id;download.onclick=()=>downloadFile(tr);} $('preview-dialog').showModal();syncDownloadUI();
      } catch {toast('原图暂时无法预览，仍可下载原文件');}
    },'image-preview-button');
    previewButton.setAttribute('aria-label',`预览原图：${tr.name}`);previewButton.append(img);
    img.addEventListener('error', () => { previewButton.hidden = true; const hint = node('p', 'image-failed', '当前浏览器无法预览，仍可下载原文件'); card.prepend(hint); }, { once: true }); card.append(previewButton);
  }
  const head = node('div', 'file-card-header'); const fileIcon = node('div', 'file-icon'); fileIcon.append(icon(tr.type.startsWith('image/') ? 'image' : 'file'));
  const info = node('div', 'file-details'); info.append(node('div', 'file-name', tr.name), node('div', 'file-size', `${size(tr.size)} · 原文件`)); head.append(fileIcon, info); card.append(head);
  let label;
  if (tr.status === 'ready') label = '已校验 · 可下载原文件';
  else if (tr.status === 'cancelled') label = '已取消上传';
  else if (job) label = job.label || '等待上传';
  else label = mine ? '上传未完成 · 重新选择原文件可续传' : '对方正在上传，完成后即可下载';
  if (tr.status === 'uploading') {
    const bar = node('div', 'file-progress'); const progress = node('progress'); progress.max = tr.size || 1; progress.value = Math.max(tr.offset, job?.live || 0); bar.append(progress); card.append(bar);
    if (tr.size) label += ` · ${Math.min(100, Math.floor(100 * Math.max(tr.offset, job?.live || 0) / tr.size))}%`;
  }
  if(tr.status==='ready'){
    const bar=node('div','file-progress');bar.dataset.downloadProgress=tr.id;bar.hidden=true;const value=node('progress');value.max=1;value.value=0;bar.append(value);card.append(bar);
  }
  const fileStatus=node('div','file-status',label);if(tr.status==='ready'){fileStatus.dataset.downloadStatus=tr.id;fileStatus.dataset.baseStatus=label;}card.append(fileStatus);
  const metrics = transferMetrics(tr, job);
  if (metrics) {
    const summary = node('div', 'transfer-metrics');
    for (const [title, value] of metrics) { const cell = node('div', 'transfer-metric'); cell.append(node('span', '', title), node('span', 'metric-value', value)); summary.append(cell); }
    card.append(summary);
  }
  const actions = node('div', 'file-actions');
  if (tr.status === 'ready') {
    const primary=button('',()=>downloadFile(tr),'file-download-primary'),text=node('span','','下载原文件');text.dataset.downloadText='';primary.append(icon('download'),text);primary.dataset.downloadId=tr.id;primary.dataset.downloadKind='primary';
    const again=button('重新下载',()=>downloadFile(tr),'file-download-again');again.dataset.downloadId=tr.id;again.dataset.downloadKind='again';again.hidden=true;
    actions.append(primary,again);
  } else if (mine && tr.status !== 'cancelled') {
    if (job?.running || job?.status === 'queued') actions.append(button('暂停', () => { stopJob(job, 'paused', '已暂停，进度已保留'); render(); }));
    else actions.append(button(job?.file ? '继续上传' : '选择原文件续传', () => {
      if (job?.file) { job.status = 'queued'; job.label = '等待继续'; pump(); render(); }
      else { resumeTarget = tr; $('resume-input').value = ''; $('resume-input').click(); }
    }));
    actions.append(button('取消', async () => {
      if (job) stopJob(job, 'cancelled', '已取消');
      try { await api(`/api/transfers/${tr.id}`, undefined, 'DELETE'); await refresh(); } catch (e) { toast(e.message); }
    }, 'muted-action'));
  }
  card.append(actions); content.append(card); row.append(content); return row;
}
function renderMessages(conv) {
  const box = $('messages'), atBottom = scrollIntent.jumping||atConversationEnd(box), oldTop = box.scrollTop;
  const entries = [];
  for (const message of conv.messages) entries.push({ key: message.id, signature: message.id, position: message.seq, make: () => messageRow(message) });
  for (const message of pending.values()) if (message.conversationId === conv.id && !conv.messages.some(x => x.clientId === message.clientId && x.sender === state.me.id))
    entries.push({ key: message.clientId, signature: `${message.clientId}:${message.sending}`, position: message.seq, make: () => messageRow(message, true) });
  for (const tr of conv.transfers) {
    const job = jobs.get(tr.id); entries.push({ key: tr.id, signature: `${tr.status}:${tr.offset}:${job?.label}:${job?.live}:${job?.running}:${job?.status}:${JSON.stringify(transferMetrics(tr, job))}`,
      position: tr.seq, make: () => fileRow(tr) });
  }
  entries.sort((a, b) => a.position - b.position);
  const fragment = document.createDocumentFragment(); const keys = new Set();
  if (!entries.length) { const empty = node('div', 'chat-empty'); empty.append(icon('chat'), node('p', '', '还没有消息'), node('p', '', '发送消息，或分享一份原文件。')); fragment.append(empty); }
  for (const entry of entries) {
    keys.add(entry.key); let cached = rowCache.get(entry.key);
    if (!cached || cached.signature !== entry.signature) { cached = { signature: entry.signature, element: entry.make() }; rowCache.set(entry.key, cached); }
    fragment.append(cached.element);
  }
  for (const key of rowCache.keys()) if (!keys.has(key)) rowCache.delete(key);
  box.replaceChildren(fragment);box.scrollTo({top:atBottom?box.scrollHeight:oldTop,behavior:scrollIntent.jumping&&!matchMedia('(prefers-reduced-motion: reduce)').matches?'smooth':'instant'});
}
async function submitMessage(message) {
  if (message.sending) return; message.sending = true; render();
  try {
    const conv=state.conversations.find(c=>c.id===message.conversationId),peer=friendById(conv?.peerId);
    if(!contentIdentity||!peer?.encryptionKey)throw Error('等待好友打开新版深入·局域网互传以自动建立加密连接，然后可重试');
    message.encrypted ||= sealForPeer(contentIdentity,peer.encryptionKey,messageContext(message.conversationId,state.me.id,message.clientId),message.text);
    await api(`/api/conversations/${message.conversationId}/messages`, { encrypted:message.encrypted, clientId: message.clientId }); pending.delete(message.clientId); await refresh(); }
  catch (e) { message.sending = false; if(e.status===400){message.encrypted=null;await refresh();} toast(e.message === 'Failed to fetch' ? '连接中断，消息已留在输入会话中，可点击重试' : e.message); render(); }
}
function sendMessage() {
  const conv = selectedConversation(), text = $('message-input').value; if (!conv || !text.trim()) return;
  if(text.length>16000){toast('消息不能超过 16000 个字符');return;}
  const message = { conversationId: conv.id, text, clientId: uid(), sender: state.me.id, time: Date.now(), seq: state.seq + 1 };
  pending.set(message.clientId, message); $('message-input').value = ''; drafts.delete(currentPeer); submitMessage(message);
}
async function sendRequest(code) {
  try { await api('/api/friends/requests', { code }); await refresh(); toast('申请已发送，请对方在「我的好友」中接受'); return true; }
  catch (e) { toast(e.message); $('add-error').textContent = e.message; return false; }
}

// One worker and one upload request per browser. Acknowledgement bounds memory to one block.
let pumping = false;
function stopJob(job, status, label) {
  job.meter?.pause(); saveMeter(job, true);
  job.status = status; job.label = label; job.running = false; job.epoch = (job.epoch || 0) + 1;
  job.abort?.abort(); job.xhr?.abort(); job.worker?.terminate(); job.resolveRun?.(); job.resolveRun = null;
}
async function retry(job, action) {
  return withRetry(() => { job.meter?.resume(job.tr?.offset || 0); return action(); }, { signal: job.abort.signal, onRetry: count => {
    job.meter?.pause(); saveMeter(job, true);
    job.label = '连接中断，等待恢复后自动继续'; render();
    if (job.preparing && count === 0) toast('网络中断：正在保留这次上传，恢复后会自动继续');
  } });
}
function uploadBlock(job, event) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); job.xhr = xhr;
    job.live = job.tr.offset; job.meter?.observe(job.live);
    xhr.open('PUT', `/api/transfers/${job.id}/chunks/${event.index}`); xhr.timeout = 120000;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream'); xhr.setRequestHeader('X-Chunk-SHA256', event.hash);
    if(event.resumeHash)xhr.setRequestHeader('X-Resume-SHA256',event.resumeHash);
    let last = 0;
    xhr.upload.onprogress = e => { job.live = event.index * job.tr.chunkSize + Math.floor((event.plainLength ?? event.buffer.byteLength)*Math.min(1,e.loaded/event.buffer.byteLength)); job.label = '正在上传'; job.meter?.observe(job.live); saveMeter(job); if (Date.now() - last > 180) { last = Date.now(); render(); } };
    xhr.onload = async () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status === 409) { const remote = await api(`/api/transfers/${job.id}`); if (remote.hashes[event.index] === event.hash) { resolve(remote); return; } }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else { const error = new Error(data.error || '上传失败'); error.status = xhr.status; reject(error); }
      } catch (e) { reject(e); }
    };
    xhr.onerror = xhr.ontimeout = () => reject(new Error('连接中断'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    xhr.send(event.buffer);
  });
}
async function runJob(job) {
  job.running = true; job.status = 'uploading'; job.label = '读取上传进度'; job.abort = new AbortController();
  const epoch = job.epoch = (job.epoch || 0) + 1; render();
  try {
    job.tr = await retry(job, () => api(`/api/transfers/${job.id}`, undefined, 'GET', job.abort.signal));
    if (epoch !== job.epoch) return;
    if (job.tr.status === 'ready') { await finishJob(job); return; }
    if (job.tr.status !== 'uploading') throw new Error('这个上传已经取消');
    if (job.file.size !== job.tr.size || job.file.name !== job.tr.name) throw new Error('请重新选择名称和大小都相同的原文件');
    job.live = job.tr.offset;
    ensureMeter(job).resume(job.tr.offset); job.meter.observe(job.tr.offset); job.phase = 'uploading';
    const worker = job.worker = new Worker('/hash-worker.js', { type: 'module' });
    await new Promise((resolve, reject) => {
      job.resolveRun = resolve;
      worker.onerror = () => reject(new Error('文件校验程序未能启动，请刷新网页后重试'));
      worker.onmessage = async ({ data }) => {
        if (job.epoch !== epoch) return;
        try {
          if (data.kind === 'error') throw new Error(data.message);
          if (data.kind === 'verified') { job.label = `校验已上传部分 ${size(data.bytes)}`; render(); }
          if (data.kind === 'chunk') {
            job.label = '正在上传';
            const remote = await retry(job, () => uploadBlock(job, data));
            if (job.epoch !== epoch) return;
            job.tr = remote; job.live = remote.offset; job.meter.observe(remote.offset); saveMeter(job); worker.postMessage({ kind: 'ack' }); refresh();
          }
          if (data.kind === 'complete') {
            job.label = '正在校验完整加密文件…'; job.phase = 'verifying'; render();
            job.tr = await retry(job, () => api(`/api/transfers/${job.id}/complete`, { sha256: data.sha256, manifest:data.manifest, elapsedMs: job.meter.snapshot().elapsedMs }, 'POST', job.abort.signal));
            if (job.epoch !== epoch) return;
            worker.terminate(); await finishJob(job); resolve();
          }
        } catch (e) { reject(e); }
      };
      worker.postMessage({ kind: 'start', file: job.file, chunkSize: job.tr.chunkSize, hashes: job.tr.resumeHashes || job.tr.hashes,
        encryption:job.tr.encryption ? {key:fileSecret(job.tr),context:fileContext(job.tr),wireHashes:job.tr.hashes} : undefined });
    });
  } catch (e) {
    if (epoch === job.epoch && e.name !== 'AbortError') { stopJob(job, 'error', e.message); toast(e.message); }
  } finally {
    if (epoch === job.epoch) { job.running = false; job.worker?.terminate(); job.resolveRun = null; }
    render();
  }
}
async function pump() {
  if (pumping) return; pumping = true;
  try { let job; while ((job = [...jobs.values()].find(x => x.status === 'queued'))) await runJob(job); }
  finally { pumping = false; }
}
async function queueFiles(files, target) {
  const conv = selectedConversation(); if (!conv && !target) { toast('先打开一位好友的聊天，再发送文件'); return; }
  for (const file of files) {
    if (file.size > state.config.maxFileSize) { toast(`${file.name} 超过单文件 10GB 上限`); continue; }
    try {
      const creation = { conversationId: conv?.id, sender:state.me.id, name: file.name, size: file.size, type: (file.type || 'application/octet-stream').slice(0,120), clientId: uid() };
      if(!target) {
        const peer=friendById(conv.peerId);if(!contentIdentity||!peer?.encryptionKey)throw Error('等待好友打开新版深入·局域网互传以自动建立加密连接，然后可发送文件');
        creation.encryption={v:1,key:sealForPeer(contentIdentity,peer.encryptionKey,['file-key',fileContext(creation)],bytesToHex(randomBytes(32)))};
      }
      const preparation = { abort: new AbortController(), preparing: true };
      const tr = target || await retry(preparation, () => api('/api/transfers', creation, 'POST', preparation.abort.signal));
      if (file.name !== tr.name || file.size !== tr.size) { toast('请选择名称和大小都相同的原文件'); continue; }
      const existing = jobs.get(tr.id); if (existing?.running) { toast('这个文件已经在上传'); continue; }
      jobs.set(tr.id, { id: tr.id, tr, file, status: 'queued', label: '等待上传', time: Date.now(), seq: state.seq + 0.5, epoch: 0, meter: existing?.meter });
      await refresh(); pump();
    } catch (e) { toast(e.message); }
  }
}

document.querySelectorAll('[data-view]').forEach(item => item.addEventListener('click', () => switchView(item.dataset.view)));
document.querySelectorAll('[data-close]').forEach(item => item.addEventListener('click', () => $(item.dataset.close).close()));
let previewBackdropPressed = false;
$('preview-dialog').addEventListener('pointerdown', event => { previewBackdropPressed = event.target === $('preview-dialog'); });
$('preview-dialog').addEventListener('pointercancel', () => { previewBackdropPressed = false; });
$('preview-dialog').addEventListener('click', event => {
  if (previewBackdropPressed && event.target === $('preview-dialog')) $('preview-dialog').close();
  previewBackdropPressed = false;
});
$('search').addEventListener('input', renderSidebar);
$('discover-button').addEventListener('click', () => { switchView('chats'); $('online-neighbors')?.scrollIntoView({ block: 'nearest' }); $('online-neighbors')?.focus({ preventScroll: true }); });
$('back-button').addEventListener('click', () => { $('app').classList.remove('chat-open'); });
$('help-button').addEventListener('click', () => { updateReminderControl(); $('help-dialog').showModal(); });
$('completion-reminder-button').addEventListener('click', async () => {
  if (!completionNotices.supported) { toast('当前地址仅支持页面内完成提醒'); return; }
  const control = $('completion-reminder-button'); control.disabled = true;
  try {
    if (completionNotices.enabled) completionNotices.disable(); else await completionNotices.enable();
    updateReminderControl();
    toast(completionNotices.enabled ? '系统完成提醒已开启' : completionNotices.permission === 'denied' ? '通知被浏览器阻止，页面提醒仍可使用' : '页面完成提醒保持开启');
  } finally { control.disabled = false; }
});
$('add-button').addEventListener('click', () => { $('add-error').textContent = ''; $('add-dialog').showModal(); });
$('welcome-add-button').addEventListener('click', () => $('add-button').click());
$('workspace-profile').addEventListener('click', () => $('profile-button').click());
$('profile-button').addEventListener('click', () => { $('nickname').value = state?.me.nickname || ''; $('identity-error').textContent = ''; $('identity-dialog').showModal(); });
$('identity-dialog').addEventListener('cancel', e => { if (!state) e.preventDefault(); });
$('identity-form').addEventListener('submit', async e => {
  e.preventDefault(); const submit = e.target.querySelector('button[type=submit]'); submit.disabled = true;
  try { await api('/api/profile', { nickname: $('nickname').value }); $('identity-dialog').close(); connect(); await refresh(); }
  catch (error) { $('identity-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
$('add-form').addEventListener('submit', async e => { e.preventDefault(); if (await sendRequest($('friend-code').value)) { $('add-dialog').close(); $('friend-code').value = ''; } });
$('copy-code').addEventListener('click', async () => {
  if (!state) return;
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(state.me.code);
    else { const input = node('textarea'); input.value = state.me.code; document.body.append(input); input.select(); const ok = document.execCommand('copy'); input.remove(); if (!ok) throw new Error(); }
    toast('好友码已复制，发给同一局域网的朋友吧');
  } catch { toast(`你的好友码：${state.me.code}`); }
});
$('send-button').addEventListener('click', sendMessage);
$('message-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(max-width:720px)').matches) { e.preventDefault(); sendMessage(); } });
$('message-input').addEventListener('input', () => { if (currentPeer) drafts.set(currentPeer, $('message-input').value); });
$('choose-files').addEventListener('click', () => $('file-input').click());
$('choose-images').addEventListener('click', () => $('image-input').click());
for (const id of ['file-input', 'image-input']) $(id).addEventListener('change', e => { queueFiles([...e.target.files]); e.target.value = ''; });
$('resume-input').addEventListener('change', e => { if (e.target.files[0] && resumeTarget) queueFiles([e.target.files[0]], resumeTarget); resumeTarget = null; e.target.value = ''; });
$('composer').addEventListener('paste', e => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); queueFiles(files); } });
let dragDepth = 0;
document.addEventListener('dragenter', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); dragDepth++; if (currentPeer) $('drop-overlay').hidden = false; } });
document.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop-overlay').hidden = true; });
document.addEventListener('drop', e => { if (!e.dataTransfer?.files.length) return; e.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true; queueFiles([...e.dataTransfer.files]); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refresh(); setRead(selectedConversation()); } });
window.addEventListener('online', () => { refresh(); });
function startMetricsTimer() {
  return setInterval(() => { if ([...jobs.values()].some(job => job.running)) {
    for (const job of jobs.values()) if (job.running) saveMeter(job);
    if (document.visibilityState === 'visible') render();
  } }, 1000);
}
let metricsTimer = startMetricsTimer();
window.addEventListener('pagehide', () => {
  for(const item of previewCache.values()){item.expired=true;if(item.url)URL.revokeObjectURL(item.url);}previewCache.clear();rowCache.clear();
  clearInterval(metricsTimer); metricsTimer = null;
  for (const job of jobs.values()) { job.meter?.pause(); saveMeter(job, true); }
  clearInterval(heartbeatTimer); clearInterval(pollTimer); pollTimer = null;
  navigator.sendBeacon('/api/leave', new Blob([JSON.stringify({ tabId })], { type: 'application/json' }));
  events?.close(); events = null;
});
window.addEventListener('pageshow', () => { if (!metricsTimer) metricsTimer = startMetricsTimer(); for (const job of jobs.values()) if (job.running) job.meter?.resume(job.live || job.tr.offset); if (state) { connect(); refresh(); } });
await refresh(); if (state) connect();
