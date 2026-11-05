const MAX_BODY = 8 * 1024;
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function authorized(request, env, url) {
  const token = env.ADMIN_TOKEN;
  if (!token) return false;
  const header = request.headers.get('Authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  return bearer === token || url.searchParams.get('token') === token;
}

function csvCell(value) {
  const s = String(value == null ? '' : value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
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
    if (!/^[A-Za-z][A-Za-z0-9_]{2,19}$/.test(s)) return '需字母开头，3–20 位，只能用字母、数字、下划线';
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
    return '';
  }
};

async function handleRegister(request, env) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: 'body-too-large', message: '内容过长' }, 413);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'bad-json', message: '请求格式错误' }, 400);
  }

  const fields = {};
  const errors = {};
  let firstError = '';

  for (const key of ['surname', 'username', 'phone', 'email']) {
    const value = key === 'phone'
      ? String(body[key] || '').replace(/[\s-]/g, '').slice(0, 20)
      : String(body[key] || '').trim().slice(0, 120);
    fields[key] = value;
    const msg = RULES[key](value);
    if (msg) {
      errors[key] = msg;
      firstError = firstError || msg;
    }
  }

  if (Object.keys(errors).length) {
    return json({ ok: false, error: 'validation', message: firstError, errors }, 400);
  }

  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const ipHash = (await sha256(ip + (env.ADMIN_TOKEN || 'salt'))).slice(0, 16);
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();

  const recent = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM users WHERE ip_hash = ? AND created_at > ?')
    .bind(ipHash, since)
    .first('n');

  if ((recent || 0) >= RATE_LIMIT) {
    return json({ ok: false, error: 'rate-limited', message: '提交太频繁，请稍后再试' }, 429);
  }

  const dup = await env.DB
    .prepare(`SELECT
        (SELECT COUNT(*) FROM users WHERE lower(username) = lower(?)) AS u,
        (SELECT COUNT(*) FROM users WHERE lower(email) = lower(?)) AS e,
        (SELECT COUNT(*) FROM users WHERE phone = ?) AS p`)
    .bind(fields.username, fields.email, fields.phone)
    .first();

  if (dup && (dup.u || dup.e || dup.p)) {
    const dupErrors = {};
    if (dup.u) dupErrors.username = '这个用户名已被占用';
    if (dup.e) dupErrors.email = '这个邮箱已注册过';
    if (dup.p) dupErrors.phone = '这个手机号已注册过';
    const message = Object.values(dupErrors)[0];
    return json({ ok: false, error: 'duplicate', message, errors: dupErrors }, 409);
  }

  try {
    const result = await env.DB
      .prepare('INSERT INTO users (surname, username, email, phone, ip_hash, ua, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(
        fields.surname,
        fields.username,
        fields.email,
        fields.phone,
        ipHash,
        (request.headers.get('User-Agent') || '').slice(0, 200),
        new Date().toISOString()
      )
      .run();
    return json({ ok: true, user: { id: result.meta.last_row_id, ...fields } }, 201);
  } catch (err) {
    const msg = String((err && err.message) || '');
    if (msg.includes('UNIQUE')) {
      return json({ ok: false, error: 'duplicate', message: '信息已存在，请换一个用户名/邮箱/手机号' }, 409);
    }
    throw err;
  }
}

async function handleList(request, env, url) {
  if (!authorized(request, env, url)) return json({ ok: false, error: 'unauthorized' }, 401);

  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

  const { results } = await env.DB
    .prepare('SELECT id, surname, username, phone, email, created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .bind(limit, offset)
    .all();

  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first('n');

  return json({ ok: true, total: total || 0, limit, offset, rows: results });
}

async function handleExport(request, env, url) {
  if (!authorized(request, env, url)) return json({ ok: false, error: 'unauthorized' }, 401);

  const { results } = await env.DB
    .prepare('SELECT id, surname, username, phone, email, created_at FROM users ORDER BY created_at DESC')
    .all();

  const lines = ['id,surname,username,phone,email,created_at'];
  for (const r of results) {
    lines.push([r.id, r.surname, r.username, r.phone, r.email, r.created_at].map(csvCell).join(','));
  }

  return new Response('\uFEFF' + lines.join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="users.csv"',
      'Cache-Control': 'no-store'
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || url.origin,
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    try {
      if (url.pathname === '/api/health') return json({ ok: true, ts: new Date().toISOString() });
      if (url.pathname === '/api/register' && request.method === 'POST') return await handleRegister(request, env);
      if (url.pathname === '/api/users' && request.method === 'GET') return await handleList(request, env, url);
      if (url.pathname === '/api/export.csv' && request.method === 'GET') return await handleExport(request, env, url);
      return json({ ok: false, error: 'not-found' }, 404);
    } catch (err) {
      return json({ ok: false, error: 'server-error', detail: String(err && err.message) }, 500);
    }
  }
};
