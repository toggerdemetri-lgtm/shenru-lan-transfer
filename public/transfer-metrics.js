const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export class TransferMeter {
  constructor(saved = {}, now = () => performance.now()) {
    this.now = now; this.elapsed = valid(saved.elapsedMs) ? saved.elapsedMs : 0;
    this.activeAt = null; this.bytes = 0; this.samples = [];
  }
  resume(offset = this.bytes) {
    if (this.activeAt !== null) return;
    this.activeAt = this.now(); this.bytes = Math.max(0, offset || 0);
    this.samples = [{ at: this.activeAt, bytes: this.bytes }];
  }
  observe(bytes) {
    if (!valid(bytes)) return;
    const at = this.now();
    if (bytes < this.bytes) this.samples = [];
    this.bytes = bytes;
    if (this.activeAt === null) return;
    const last = this.samples.at(-1);
    if (last?.at === at) last.bytes = bytes; else this.samples.push({ at, bytes });
    while (this.samples.length > 2 && this.samples[1].at <= at - 5000) this.samples.shift();
  }
  elapsedMs() { return this.elapsed + (this.activeAt === null ? 0 : Math.max(0, this.now() - this.activeAt)); }
  pause() { this.elapsed = this.elapsedMs(); this.activeAt = null; this.samples = []; }
  snapshot() { return { elapsedMs: Math.round(this.elapsedMs()) }; }
  stats(total) {
    this.observe(this.bytes);
    const first = this.samples[0], last = this.samples.at(-1);
    const span = first && last ? last.at - first.at : 0;
    const rate = this.activeAt !== null && span >= 250 ? Math.max(0, (last.bytes - first.bytes) * 1000 / span) : null;
    return { rate, elapsedMs: this.elapsedMs(), remainingSeconds: rate > 0 ? Math.max(0, Math.ceil((total - this.bytes) / rate)) : null };
  }
}
export function formatDuration(ms) {
  if (!valid(ms)) return '—';
  const seconds = Math.floor(ms / 1000), hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60, remainder = seconds % 60;
  return `${hours ? hours + ':' : ''}${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}
export function formatRate(bytesPerSecond) {
  if (!valid(bytesPerSecond)) return '—';
  if (bytesPerSecond >= 1e9) return `${(bytesPerSecond / 1e9).toFixed(1)} GB/s`;
  if (bytesPerSecond >= 1e6) return `${(bytesPerSecond / 1e6).toFixed(1)} MB/s`;
  if (bytesPerSecond >= 1000) return `${(bytesPerSecond / 1000).toFixed(0)} KB/s`;
  return `${Math.round(bytesPerSecond)} B/s`;
}
export function formatRemaining(seconds) {
  if (!valid(seconds)) return '计算中';
  if (seconds < 60) return `约${Math.ceil(seconds)}秒`;
  if (seconds < 3600) return `约${Math.ceil(seconds / 60)}分`;
  return `约${Math.ceil(seconds / 3600)}小时`;
}
