import { formatDuration, formatRate } from './transfer-metrics.js';
const read = (store, key) => { try { return store?.getItem(key); } catch { return null; } };
const write = (store, key, value) => { try { store?.setItem(key, value); } catch {} };
export class CompletionNotifier {
  constructor({ NotificationClass, secure = false, preferences, session } = {}) {
    this.Notice = NotificationClass; this.secure = secure; this.preferences = preferences; this.session = session;
    this.optedIn = read(preferences, 'shenru-completion-reminders') === 'on'; this.seen = new Set();
  }
  get supported() { return this.secure && typeof this.Notice === 'function' && typeof this.Notice.requestPermission === 'function'; }
  get permission() { try { return this.Notice?.permission || 'default'; } catch { return 'denied'; } }
  get enabled() { return this.supported && this.optedIn && this.permission === 'granted'; }
  async enable() {
    if (!this.supported || this.permission === 'denied') return false;
    try {
      const permission = this.permission === 'granted' ? 'granted' : await this.Notice.requestPermission();
      this.optedIn = permission === 'granted'; write(this.preferences, 'shenru-completion-reminders', this.optedIn ? 'on' : 'off');
    } catch { this.optedIn = false; }
    return this.enabled;
  }
  disable() { this.optedIn = false; write(this.preferences, 'shenru-completion-reminders', 'off'); }
  complete(tr, key, onOpen) {
    if (tr.status !== 'ready' || this.seen.has(key) || read(this.session, `shenru-completion:${key}`)) return null;
    this.seen.add(key); write(this.session, `shenru-completion:${key}`, '1');
    let system = false;
    if (this.enabled) {
      try {
        const detail = Number.isFinite(tr.elapsedMs) && tr.elapsedMs > 0 ? `\n总耗时 ${formatDuration(tr.elapsedMs)} · 平均速度 ${formatRate(tr.size * 1000 / tr.elapsedMs)}` : '';
        const notice = new this.Notice('上传完成，已通过校验', { body: `${tr.name}${detail}\n点击查看文件`, icon: '/brand/logo.png', tag: `shenru-${key}` });
        notice.onclick = () => { try { onOpen(); } finally { notice.close(); } }; system = true;
      } catch {}
    }
    return { system };
  }
}
