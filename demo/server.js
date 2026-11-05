'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'users.jsonl');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'demo-token';
const RATE_LIMIT = 10;
const RATE_WINDOW = 60 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

let users = [];
const seen = { username: new Set(), email: new Set(), phone: new Set() };
const hits = new Map();

function load() {
  users = [];
  for (const k of Object.keys(seen)) seen[k].clear();
  if (!fs.existsSync(DB_FILE)) return;
  const lines = fs.readFileSync(DB_FILE, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const u = JSON.parse(line);
      users.push(u);
      seen.username.add(u.username.toLowerCase());
      seen.email.add(u.email.toLowerCase());
      seen.phone.add(u.phone);
    } catch (e) {}
  }
}

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { n: 0, t: now };
  if (now - rec.t > RATE_WINDOW) { rec.n = 0; rec.t = now; }
  rec.n += 1;
  hits.set(ip, rec);
  return rec.n > RATE_LIMIT;
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

const RULES = {
  surname(v) {
    const s = String(v || '').trim();
    if (!s) return '请填写姓';
    if (s.length > 20) return '姓不能超过 20 个字符';
    if (/[0-9]/.test(s)) return '姓不能包含数字';
    return '';
  },
  username(v) {
    const s = String(v || '').trim();
    if (!s) return '请填写用户名';
    if (!/^[A-Za-z][A-Za-z0-9_]{2,19}$/.test(s)) {
      return '需字母开头，3–20 位，只能用字母、数字、下划线';
    }
    return '';
  },
  phone(v) {
    const s = String(v || '').replace(/[\s-]/g, '');
    if (!s) return '请填写手机号';
    if (!/^1[3-9]\d{9}$/.test(s)) return '请填写 11 位手机号';
    return '';
  },
  email(v) {
    const s = String(v || '').trim();
    if (!s) return '请填写邮箱';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return '邮箱格式不正确';
    if (s.length > 120) return '邮箱过长';
    return '';
  }
};

async function register(req, res) {
  const ip = (req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (rateLimited(ip)) return send(res, 429, { ok: false, error: 'rate-limited', message: '提交太频繁，请稍后再试' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return send(res, 400, { ok: false, error: 'bad-json', message: '请求格式错误' });
  }

  const fields = {};
  const errors = {};
  let firstError = '';

  for (const key of ['surname', 'username', 'phone', 'email']) {
    const raw = key === 'phone' ? String(body[key] || '').replace(/[\s-]/g, '') : String(body[key] || '').trim();
    fields[key] = raw;
    const msg = RULES[key](raw);
    if (msg) { errors[key] = msg; firstError = firstError || msg; }
  }

  if (Object.keys(errors).length) {
    return send(res, 400, { ok: false, error: 'validation', message: firstError, errors });
  }

  if (seen.username.has(fields.username.toLowerCase())) {
    return send(res, 409, { ok: false, error: 'duplicate', message: '这个用户名已被占用', errors: { username: '这个用户名已被占用' } });
  }
  if (seen.email.has(fields.email.toLowerCase())) {
    return send(res, 409, { ok: false, error: 'duplicate', message: '这个邮箱已注册过', errors: { email: '这个邮箱已注册过' } });
  }
  if (seen.phone.has(fields.phone)) {
    return send(res, 409, { ok: false, error: 'duplicate', message: '这个手机号已注册过', errors: { phone: '这个手机号已注册过' } });
  }

  const user = {
    id: users.length ? users[users.length - 1].id + 1 : 1,
    surname: fields.surname,
    username: fields.username,
    phone: fields.phone,
    email: fields.email,
    ip_hash: crypto.createHash('sha256').update(ip + ADMIN_TOKEN).digest('hex').slice(0, 16),
    created_at: new Date().toISOString()
  };

  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.appendFile(DB_FILE, JSON.stringify(user) + '\n', 'utf8');

  users.push(user);
  seen.username.add(user.username.toLowerCase());
  seen.email.add(user.email.toLowerCase());
  seen.phone.add(user.phone);

  return send(res, 201, {
    ok: true,
    user: { id: user.id, surname: user.surname, username: user.username, phone: user.phone, email: user.email }
  });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.normalize(path.join(PUBLIC, rel));
  if (!target.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(target).pipe(res);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/health') return send(res, 200, { ok: true, count: users.length });

  if (url.pathname === '/api/register' && req.method === 'POST') {
    return register(req, res).catch((e) => send(res, 500, { ok: false, error: 'server-error', message: String(e.message) }));
  }

  if (url.pathname === '/api/users' && req.method === 'GET') {
    if (url.searchParams.get('token') !== ADMIN_TOKEN) return send(res, 401, { ok: false, error: 'unauthorized' });
    return send(res, 200, { ok: true, total: users.length, rows: users.slice().reverse() });
  }

  if (url.pathname.startsWith('/api/')) return send(res, 404, { ok: false, error: 'not-found' });

  serveStatic(req, res, url);
}).listen(PORT, () => {
  load();
  console.log(`demo running  http://localhost:${PORT}`);
  console.log(`已载入 ${users.length} 条记录`);
});
