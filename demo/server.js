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
const seenPairs = new Set();
const hits = new Map();

const pairKey = (username, address) =>
  String(username || '').trim().toLowerCase() + '|' + String(address || '').trim().toLowerCase();

function load() {
  users = [];
  seenPairs.clear();
  if (!fs.existsSync(DB_FILE)) return;
  const lines = fs.readFileSync(DB_FILE, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const u = JSON.parse(line);
      users.push(u);
      seenPairs.add(pairKey(u.username, u.address));
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

// 与 worker/src/index.js 保持一致
const RULES = {
  username(v) {
    const s = String(v || '').trim().replace(/\s+/g, ' ');
    if (!s) return { code: 'name-required', message: 'Please enter your full name: surname and first name.' };
    if (s.length < 2) return { code: 'name-too-short', message: 'Name is too short: at least 2 characters. Enter surname and first name.' };
    if (s.length > 80) return { code: 'name-too-long', message: 'Name is too long: 80 characters maximum.' };
    if (!/\p{L}/u.test(s)) return { code: 'name-no-letters', message: 'Name must contain letters: digits or symbols only are not accepted.' };
    return null;
  },
  address(v) {
    const s = String(v || '').trim().replace(/\s+/g, ' ');
    if (!s) return { code: 'address-required', message: 'Please enter your residential address.' };
    if (s.length < 5) return { code: 'address-too-short', message: 'Address is too short: at least 5 characters.' };
    if (s.length > 200) return { code: 'address-too-long', message: 'Address is too long: 200 characters maximum.' };
    return null;
  }
};

async function register(req, res) {
  const ip = (req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (rateLimited(ip)) return send(res, 429, { ok: false, error: 'rate-limited', message: 'Too many submissions from this network, please try again later.' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return send(res, 400, { ok: false, error: 'bad-json', message: 'Invalid JSON body.' });
  }

  const fields = {};
  const errors = {};
  let firstError = '';

  for (const key of ['username', 'address']) {
    const raw = String(body[key] || '').trim().replace(/\s+/g, ' ').slice(0, 220);
    fields[key] = raw;
    const err = RULES[key](raw);
    if (err) { errors[key] = err.code; firstError = firstError || err.message; }
  }

  if (Object.keys(errors).length) {
    return send(res, 400, { ok: false, error: 'validation', message: firstError, errors });
  }

  // 去重：姓名 + 居住地址 都相同才算重复
  if (seenPairs.has(pairKey(fields.username, fields.address))) {
    return send(res, 409, {
      ok: false,
      error: 'duplicate',
      message: 'This entry already exists: the name and residential address are the same.',
      errors: { username: 'name-address-duplicate' }
    });
  }

  const user = {
    id: users.length ? users[users.length - 1].id + 1 : 1,
    username: fields.username,
    address: fields.address,
    ip,
    created_at: new Date().toISOString()
  };

  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.appendFile(DB_FILE, JSON.stringify(user) + '\n', 'utf8');

  users.push(user);
  seenPairs.add(pairKey(user.username, user.address));

  return send(res, 201, {
    ok: true,
    user: { id: user.id, username: user.username, address: user.address }
  });
}

function adminOk(req, url) {
  const h = req.headers['authorization'] || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  // 本地开发方便，也接受 ?token=（线上 Worker 默认已关闭这种用法）
  return bearer === ADMIN_TOKEN || url.searchParams.get('token') === ADMIN_TOKEN;
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
    if (!adminOk(req, url)) return send(res, 401, { ok: false, error: 'unauthorized' });
    return send(res, 200, { ok: true, total: users.length, rows: users.slice().reverse() });
  }

  if (url.pathname === '/api/export.csv' && req.method === 'GET') {
    if (!adminOk(req, url)) return send(res, 401, { ok: false, error: 'unauthorized' });
    const csvCell = (v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
    const lines = ['id,username,address,ip,created_at'];
    for (const u of users.slice().reverse()) {
      lines.push([u.id, u.username, u.address, u.ip, u.created_at].map(csvCell).join(','));
    }
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="registrations.csv"',
      'Cache-Control': 'no-store'
    });
    return res.end('\uFEFF' + lines.join('\r\n'));
  }

  if (url.pathname.startsWith('/api/')) return send(res, 404, { ok: false, error: 'not-found' });

  serveStatic(req, res, url);
}).listen(PORT, () => {
  load();
  console.log(`demo running  http://localhost:${PORT}`);
  console.log(`loaded ${users.length} records`);
});
