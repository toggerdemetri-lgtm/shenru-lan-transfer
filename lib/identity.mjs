import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
export const digest = value => createHash('sha256').update(value).digest('hex');
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const requireThat = (condition, status, message) => { if (!condition) throw new HttpError(status, message); };
export class IdentityStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, nickname TEXT NOT NULL, code TEXT UNIQUE NOT NULL, token_hash TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, sender TEXT NOT NULL REFERENCES users(id), recipient TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS friends(a TEXT NOT NULL REFERENCES users(id), b TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(a,b));`);
    this.db.exec('CREATE TABLE IF NOT EXISTS content_keys(user_id TEXT PRIMARY KEY REFERENCES users(id), public_key TEXT NOT NULL)');
  }
  public(user) { return user ? { id: user.id, nickname: user.nickname, code: user.code, encryptionKey: this.key(user.id) } : null; }
  key(id) { return this.db.prepare('SELECT public_key FROM content_keys WHERE user_id=?').get(id)?.public_key || null; }
  setKey(id, key) { this.db.prepare('INSERT INTO content_keys VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET public_key=excluded.public_key').run(id,key); }
  get(id) { return this.public(this.db.prepare('SELECT * FROM users WHERE id=?').get(id)); }
  authenticate(cookie = '') {
    const token = /(?:^|;\s*)lan_token=([a-f0-9]{64})(?:;|$)/.exec(cookie)?.[1];
    return token ? this.public(this.db.prepare('SELECT * FROM users WHERE token_hash=?').get(digest(token))) : null;
  }
  profile(nickname, current) {
    requireThat(typeof nickname === 'string' && nickname.trim().length >= 1 && nickname.trim().length <= 24, 400, '昵称需要 1–24 个字符');
    nickname = nickname.trim();
    if (current) { this.db.prepare('UPDATE users SET nickname=? WHERE id=?').run(nickname, current.id); return { user: this.get(current.id) }; }
    const token = randomBytes(32).toString('hex'), id = randomUUID(); let code;
    do { code = randomBytes(4).toString('hex').toUpperCase(); } while (this.db.prepare('SELECT id FROM users WHERE code=?').get(code));
    this.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id, nickname, code, digest(token));
    return { user: this.get(id), token };
  }
  isFriend(a, b) { return !!this.db.prepare('SELECT 1 FROM friends WHERE a=? AND b=?').get(...[a, b].sort()); }
  friends(id) {
    return this.db.prepare('SELECT u.id,u.nickname,u.code FROM friends f JOIN users u ON u.id=CASE WHEN f.a=? THEN f.b ELSE f.a END WHERE f.a=? OR f.b=?').all(id, id, id).map(x=>({...x,encryptionKey:this.key(x.id)}));
  }
  requests(id) {
    return this.db.prepare(`SELECT r.id,r.sender,r.recipient,r.status,u.nickname,u.code FROM requests r JOIN users u ON u.id=CASE WHEN r.sender=? THEN r.recipient ELSE r.sender END WHERE (r.sender=? OR r.recipient=?) AND r.status='pending'`).all(id, id, id);
  }
  request(sender, code) {
    requireThat(typeof code === 'string', 400, '请输入好友码');
    const recipient = this.db.prepare('SELECT id FROM users WHERE code=?').get(code.trim().toUpperCase())?.id;
    requireThat(recipient, 404, '没有找到这个好友码'); requireThat(recipient !== sender, 400, '不能添加自己为好友');
    requireThat(!this.isFriend(sender, recipient), 409, '你们已经是好友');
    const existing = this.db.prepare("SELECT * FROM requests WHERE ((sender=? AND recipient=?) OR (sender=? AND recipient=?)) AND status='pending'").get(sender, recipient, recipient, sender);
    if (existing) return existing;
    const id = randomUUID(); this.db.prepare("INSERT INTO requests VALUES(?,?,?,'pending')").run(id, sender, recipient);
    return { id, sender, recipient, status: 'pending' };
  }
  decide(id, recipient, accept) {
    const request = this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    requireThat(request, 404, '申请不存在'); requireThat(request.recipient === recipient, 403, '只有收到申请的人可以处理');
    requireThat(typeof accept === 'boolean', 400, '请选择接受或拒绝');
    if (request.status !== 'pending') { requireThat(request.status === (accept ? 'accepted' : 'declined'), 409, '申请已处理'); return request; }
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE requests SET status=? WHERE id=?').run(accept ? 'accepted' : 'declined', id);
      if (accept) this.db.prepare('INSERT OR IGNORE INTO friends VALUES(?,?)').run(...[request.sender, recipient].sort());
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { ...request, status: accept ? 'accepted' : 'declined' };
  }
  close() { this.db.close(); }
}
