#!/usr/bin/env node
/*
 * Tech Arena 报名站 — VPS 版（Node.js 24+，零 npm 依赖）
 *
 * 从 worker/src/index.js 1:1 移植：
 *   POST /api/register   报名（校验 + 按姓名+地址去重 + 限流）
 *   GET  /api/users      报名列表（Bearer ADMIN_TOKEN）
 *   GET  /api/export.csv 导出 CSV（Bearer ADMIN_TOKEN）
 *   GET  /api/health     健康检查（公开）
 *   其余路径             静态文件（./public）
 *
 * 数据库：node:sqlite（Node 24 内置），库文件 ./data/tech-arena.db
 * 反向代理：Caddy/Nginx 终结 HTTPS 后转发到 127.0.0.1:$PORT，
 *          TRUST_PROXY=1 时从 X-Forwarded-For 取真实 IP。
 *
 * 环境变量：
 *   PORT=8788            监听端口（默认只绑 127.0.0.1，由反代对外）
 *   ADMIN_TOKEN=...      后台接口令牌（必填，否则 /api/users、/api/export.csv 一律 401）
 *   TRUST_PROXY=1        经过反代时开启，取 X-Forwarded-For 第一段作为客户端 IP
 *   ALLOW_ORIGIN=...     可选：前端单独域名时允许的跨域来源（默认同源，不开跨域）
 *   ALLOW_QUERY_TOKEN=1  可选：兼容 ?token= 老用法（不建议，会进访问日志）
 *   PUBLIC_DIR=./public  静态目录
 *   DB_FILE=./data/tech-arena.db
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

/* ---------------- 配置 ---------------- */
const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '';
const ALLOW_QUERY_TOKEN = process.env.ALLOW_QUERY_TOKEN === '1';
const ROOT = __dirname;
const PUBLIC_DIR = path.resolve(ROOT, process.env.PUBLIC_DIR || './public');
const DB_FILE = path.resolve(ROOT, process.env.DB_FILE || './data/tech-arena.db');

const MAX_BODY = 8 * 1024;            // 与 worker 一致：请求体上限 8KB
const RATE_LIMIT = 10;                // 与 worker 一致：同 IP 每小时 10 次
const RATE_WINDOW_MS = 60 * 60 * 1000;

/* ---------------- 安全响应头（与 worker 一致） ---------------- */
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '),
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
};

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
};

/* ---------------- 工具 ---------------- */
/* 先哈希再比较：既用上 timingSafeEqual，又不泄露令牌长度 */
function safeEqual(a, b) {
  const A = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
  const B = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
  return crypto.timingSafeEqual(A, B);
}

function json(data, status = 200, extra = {}) {
  return { status, headers: { ...JSON_HEADERS, ...extra }, body: JSON.stringify(data) };
}

function csvCell(value) {
  const s = String(value == null ? '' : value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function corsHeaders(req) {
  if (!ALLOW_ORIGIN) return null;
  const origin = req.headers.origin || '';
  if (origin !== ALLOW_ORIGIN) return null;
  return {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

/* TRUST_PROXY=1 时取 X-Forwarded-For 第一段（最左边是原始客户端） */
function clientIP(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  }
  const ra = req.socket.remoteAddress || '';
  return ra.replace(/^::ffff:/, '') || '0.0.0.0';
}

function authorized(req, url) {
  if (!ADMIN_TOKEN) return false;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (bearer && safeEqual(bearer, ADMIN_TOKEN)) return true;
  if (ALLOW_QUERY_TOKEN) {
    const q = url.searchParams.get('token') || '';
    if (q && safeEqual(q, ADMIN_TOKEN)) return true;
  }
  return false;
}

/* ---------------- 数据库 ---------------- */
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  address    TEXT NOT NULL,
  dup_key    TEXT NOT NULL,
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_dup_key ON users (dup_key);
CREATE INDEX IF NOT EXISTS idx_users_created ON users (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_ip ON users (ip, created_at);
`);

/* ---------------- 校验规则（与 worker 完全一致） ---------------- */
/* 姓名允许任意文字（俄文/中文/拉丁），至少含一个字母；code 供前端做多语言提示 */
const RULES = {
  username(v) {
    const s = String(v || '').trim().replace(/\s+/g, ' ');
    if (!s) return { code: 'name-required', message: 'Please enter your full name: surname and first name.' };
    if (!/\p{L}/u.test(s)) return { code: 'name-no-letters', message: 'Name must contain letters, not only digits or symbols.' };
    return null;
  },
  address(v) {
    const s = String(v || '').trim().replace(/\s+/g, ' ');
    if (!s) return { code: 'address-required', message: 'Please enter your residential address.' };
    return null;
  }
};

/* ---------------- API ---------------- */
function handleRegister(req, raw) {
  if (raw.length > MAX_BODY) return json({ ok: false, error: 'body-too-large', message: 'Payload too large.' }, 413);

  let body;
  try { body = JSON.parse(raw); } catch { return json({ ok: false, error: 'bad-json', message: 'Invalid JSON body.' }, 400); }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'bad-json', message: 'Invalid JSON body.' }, 400);

  const fields = {};
  const errors = {};
  let firstError = '';
  for (const key of ['username', 'address']) {
    const value = String(body[key] || '').trim().replace(/\s+/g, ' ').slice(0, 220);
    fields[key] = value;
    const err = RULES[key](value);
    if (err) { errors[key] = err.code; firstError = firstError || err.message; }
  }
  if (Object.keys(errors).length) return json({ ok: false, error: 'validation', message: firstError, errors }, 400);

  const ip = clientIP(req);
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const recent = db.prepare('SELECT COUNT(*) AS n FROM users WHERE ip = ? AND created_at > ?').get(ip, since);
  if ((recent ? recent.n : 0) >= RATE_LIMIT) {
    return json({ ok: false, error: 'rate-limited', message: 'Too many submissions from this network, please try again later.' }, 429);
  }

  /* 去重：姓名+地址都相同才算重复；lower() 只处理 ASCII，所以用 JS 小写化拼 dup_key */
  const dupKey = (fields.username + '|' + fields.address).toLowerCase();
  const dup = db.prepare('SELECT COUNT(*) AS n FROM users WHERE dup_key = ?').get(dupKey);
  if ((dup ? dup.n : 0) > 0) {
    return json({
      ok: false, error: 'duplicate',
      message: 'This entry already exists: the name and residential address are the same.',
      errors: { username: 'name-address-duplicate' }
    }, 409);
  }

  try {
    const created = new Date().toISOString();
    const result = db.prepare('INSERT INTO users (username, address, dup_key, ip, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(fields.username, fields.address, dupKey, ip, created);
    return json({ ok: true, user: { id: Number(result.lastInsertRowid), ...fields } }, 201);
  } catch (err) {
    if (String((err && err.message) || '').includes('UNIQUE')) {
      return json({ ok: false, error: 'duplicate', message: 'This entry already exists: the name and residential address are the same.' }, 409);
    }
    throw err;
  }
}

function handleList(req, url) {
  if (!authorized(req, url)) return json({ ok: false, error: 'unauthorized' }, 401);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
  const rows = db.prepare('SELECT id, username, address, ip, created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  return json({ ok: true, total, limit, offset, rows });
}

function handleExport(req, url) {
  if (!authorized(req, url)) return json({ ok: false, error: 'unauthorized' }, 401);
  const rows = db.prepare('SELECT id, username, address, ip, created_at FROM users ORDER BY created_at DESC').all();
  const lines = ['id,username,address,ip,created_at'];
  for (const r of rows) lines.push([r.id, r.username, r.address, r.ip, r.created_at].map(csvCell).join(','));
  return {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="registrations.csv"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    },
    body: '\uFEFF' + lines.join('\r\n')
  };
}

function handleApi(req, url, raw) {
  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') {
    if (!cors) return json({ ok: false, error: 'method-not-allowed' }, 405, { Allow: 'GET, POST' });
    return { status: 204, headers: cors, body: '' };
  }

  let res;
  const p = url.pathname;
  const m = req.method;
  const notAllowed = (allow) => json({ ok: false, error: 'method-not-allowed' }, 405, { Allow: allow });

  if (p === '/api/health') res = m === 'GET' ? json({ ok: true, ts: new Date().toISOString() }) : notAllowed('GET');
  else if (p === '/api/register') res = m === 'POST' ? handleRegister(req, raw) : notAllowed('POST');
  else if (p === '/api/users') res = m === 'GET' ? handleList(req, url) : notAllowed('GET');
  else if (p === '/api/export.csv') res = m === 'GET' ? handleExport(req, url) : notAllowed('GET');
  else res = json({ ok: false, error: 'not-found' }, 404);

  if (cors) for (const [k, v] of Object.entries(cors)) res.headers[k] = v;
  return res;
}

/* ---------------- 静态文件 ---------------- */
function serveStatic(url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    return { status: 403, headers: { ...JSON_HEADERS, ...SECURITY_HEADERS }, body: JSON.stringify({ ok: false, error: 'forbidden' }) };
  }
  let stat;
  try { stat = fs.statSync(file); } catch { return null; } /* 交给 404 */
  const target = stat.isDirectory() ? path.join(file, 'index.html') : file;
  let data;
  try { data = fs.readFileSync(target); } catch { return null; }
  const ext = path.extname(target).toLowerCase();
  const isHTML = ext === '.html';
  return {
    status: 200,
    headers: {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': isHTML ? 'no-cache' : 'public, max-age=3600',
      ...SECURITY_HEADERS
    },
    body: data
  };
}

/* ---------------- HTTP 服务 ---------------- */
const server = http.createServer((req, res) => {
  const chunks = [];
  let size = 0;
  let aborted = false;

  req.on('data', (c) => {
    size += c.length;
    /* 超 8KB 直接断读，防止恶意大包占内存 */
    if (size > MAX_BODY + 1) { aborted = true; req.destroy(); return; }
    chunks.push(c);
  });

  req.on('end', () => {
    if (aborted) return;
    let out;
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        out = handleApi(req, url, Buffer.concat(chunks).toString('utf8'));
      } else if (req.method !== 'GET' && req.method !== 'HEAD') {
        out = json({ ok: false, error: 'method-not-allowed' }, 405, { Allow: 'GET, HEAD, POST, OPTIONS' });
      } else {
        out = serveStatic(url);
        if (!out) out = { status: 404, headers: { ...JSON_HEADERS, ...SECURITY_HEADERS }, body: JSON.stringify({ ok: false, error: 'not-found' }) };
      }
    } catch (err) {
      console.error('[api]', (err && err.stack) || String(err));
      out = json({ ok: false, error: 'server-error' }, 500);
    }

    if (req.method === 'HEAD') { delete out.body; out.body = undefined; }
    res.writeHead(out.status, out.headers);
    if (out.body !== undefined && out.body !== null) res.end(out.body);
    else res.end();

    if (out.status >= 400) console.log(`[${new Date().toISOString()}] ${clientIP(req)} ${req.method} ${req.url} -> ${out.status}`);
  });

  req.on('error', () => {});
});

server.listen(PORT, HOST, () => {
  console.log(`tech-arena vps server listening on http://${HOST}:${PORT}`);
  console.log(`  public: ${PUBLIC_DIR}`);
  console.log(`  db:     ${DB_FILE}`);
  console.log(`  admin:  ${ADMIN_TOKEN ? 'ADMIN_TOKEN set' : 'ADMIN_TOKEN NOT set — /api/users & /api/export.csv will 401'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig} received, closing...`);
    server.close(() => { try { db.close(); } catch {} process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
