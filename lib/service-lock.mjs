import { DatabaseSync } from 'node:sqlite';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HttpError, requireThat } from './identity.mjs';

const run = promisify(execFile);
const busy = () => new HttpError(409, '这个数据目录已经有服务在运行，请先从原服务托盘退出后重试');

async function processStartedAt(pid) {
  if (pid === process.pid) return Date.now() - process.uptime() * 1000;
  try {
    const options = { timeout: 5000, windowsHide: true, maxBuffer: 4096 };
    const { stdout } = process.platform === 'win32'
      ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], options)
      : await run('ps', ['-p', String(pid), '-o', 'lstart='], { ...options, env: { ...process.env, LC_ALL: 'C' } });
    const time = Date.parse(stdout.trim());
    return Number.isFinite(time) ? time : null;
  } catch { return null; }
}

async function migrateLegacyMarker(path) {
  // A permanent directory is an atomic format marker. Old numeric-PID clients
  // fail closed on it; new clients use the OS-held SQLite lock, never its PID.
  for (;;) {
    try { await mkdir(path); return; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const marker = await open(path, 'r').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!marker) continue;
    let legacy;
    try {
      const stat = await marker.stat();
      if (stat.isDirectory()) return;
      const pid = Number(await marker.readFile('utf8'));
      requireThat(Number.isSafeInteger(pid) && pid > 0, 409, '数据目录旧锁文件无效，请先退出原服务并检查 server.lock');
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
      if (alive) {
        const startedAt = await processStartedAt(pid);
        // Leave a margin for filesystem/ps timestamp precision. A PID alone,
        // or unavailable process information, cannot prove a legacy owner dead.
        requireThat(startedAt !== null && startedAt > stat.mtimeMs + 2000, 409, busy().message);
      }
      legacy = true;
    } finally { await marker.close(); }
    if (legacy) await unlink(path);
  }
}

export async function acquireLock(dataDir) {
  const db = new DatabaseSync(join(dataDir, 'server-lock.sqlite'));
  try {
    // SQLite's OS locks cover both independent connections in this process and
    // other processes. Crash/kill closes the handle without relying on PID reuse.
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS service_lock (id INTEGER PRIMARY KEY)');
    await migrateLegacyMarker(join(dataDir, 'server.lock'));
  } catch (error) {
    db.close();
    if (error.errcode === 5 || error.errcode === 6) throw busy();
    throw error;
  }
  let released = false;
  return () => { if (!released) { released = true; db.close(); } };
}
