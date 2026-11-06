const MAX_BODY = 8 * 1024;
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
};

/* 页面级安全响应头：限制脚本来源、禁止被内嵌、不发 Referer */
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

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra }
  });
}

function withHeaders(res, headers) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

/* 逐字符异或比较，避免 === 在第一个不同字符处提前返回而泄露前缀信息 */
function safeEqual(a, b) {
  const A = String(a == null ? '' : a);
  const B = String(b == null ? '' : b);
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A.charCodeAt(i) ^ B.charCodeAt(i);
  return diff === 0;
}

/* 默认不开跨域：接口只给同源页面用。
   只有显式配置 ALLOW_ORIGIN（例如前端单独部署在别的域名）才放行那一个来源 */
function corsHeaders(request, env) {
  const allow = env.ALLOW_ORIGIN;
  if (!allow) return null;
  const origin = request.headers.get('Origin');
  if (!origin || origin !== allow) return null;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function authorized(request, env, url) {
  const token = env.ADMIN_TOKEN;
  if (!token) return false;

  const header = request.headers.get('Authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (bearer && safeEqual(bearer, token)) return true;

  // 兼容老用法，但默认关闭：URL 里的 token 会进浏览器历史、Referer 和访问日志
  if (env.ALLOW_QUERY_TOKEN === '1') {
    const q = url.searchParams.get('token');
    if (q && safeEqual(q, token)) return true;
  }
  return false;
}

function csvCell(value) {
  const s = String(value == null ? '' : value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// 姓名允许任意文字（俄文/中文/拉丁），至少含一个字母，长度 2–80
// 规则返回 { code, message }：code 供前端做多语言提示，message 供日志 / 后台 / 直接调 API 的场景
const RULES = {
  username(v) {
    const s = String(v || '').trim().replace(/\s+/g, ' ');
    if (!s) return { code: 'name-required', message: 'Please enter your full name: surname and first name.' };
    if (s.length < 2) return { code: 'name-too-short', message: 'Name is too short: at least 2 characters. Enter surname and first name.' };
    if (s.length > 80) return { code: 'name-too-long', message: 'Name is too long: 80 characters maximum.' };
    if (!/\p{L}/u.test(s)) return { code: 'name-no-letters', message: 'Name must contain letters, not only digits or symbols.' };
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

async function handleRegister(request, env) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: 'body-too-large', message: 'Payload too large.' }, 413);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'bad-json', message: 'Invalid JSON body.' }, 400);
  }
  if (!body || typeof body !== 'object') {
    return json({ ok: false, error: 'bad-json', message: 'Invalid JSON body.' }, 400);
  }

  const fields = {};
  const errors = {};
  let firstError = '';

  for (const key of ['username', 'address']) {
    const value = String(body[key] || '').trim().replace(/\s+/g, ' ').slice(0, 220);
    fields[key] = value;
    const err = RULES[key](value);
    if (err) {
      errors[key] = err.code;
      firstError = firstError || err.message;
    }
  }

  if (Object.keys(errors).length) {
    return json({ ok: false, error: 'validation', message: firstError, errors }, 400);
  }

  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();

  const recent = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM users WHERE ip = ? AND created_at > ?')
    .bind(ip, since)
    .first('n');

  if ((recent || 0) >= RATE_LIMIT) {
    return json({ ok: false, error: 'rate-limited', message: 'Too many submissions from this network, please try again later.' }, 429);
  }

  // 去重规则：姓名 + 居住地址 都相同才算重复（同人重复提交会命中，室友同地址不同名不受影响）
  // SQLite 的 lower() 只处理 ASCII，西里尔/中文不生效，所以用 JS 小写化后拼 dup_key
  const dupKey = (fields.username + '|' + fields.address).toLowerCase();

  const dup = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM users WHERE dup_key = ?')
    .bind(dupKey)
    .first('n');

  if ((dup || 0) > 0) {
    return json({
      ok: false,
      error: 'duplicate',
      message: 'This entry already exists: the name and residential address are the same.',
      errors: { username: 'name-address-duplicate' }
    }, 409);
  }

  try {
    const result = await env.DB
      .prepare('INSERT INTO users (username, address, dup_key, ip, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(fields.username, fields.address, dupKey, ip, new Date().toISOString())
      .run();
    return json({ ok: true, user: { id: result.meta.last_row_id, ...fields } }, 201);
  } catch (err) {
    const msg = String((err && err.message) || '');
    if (msg.includes('UNIQUE')) {
      return json({ ok: false, error: 'duplicate', message: 'This entry already exists: the name and residential address are the same.' }, 409);
    }
    throw err;
  }
}

async function handleList(request, env, url) {
  if (!authorized(request, env, url)) return json({ ok: false, error: 'unauthorized' }, 401);

  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

  const { results } = await env.DB
    .prepare('SELECT id, username, address, ip, created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .bind(limit, offset)
    .all();

  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first('n');

  return json({ ok: true, total: total || 0, limit, offset, rows: results });
}

async function handleExport(request, env, url) {
  if (!authorized(request, env, url)) return json({ ok: false, error: 'unauthorized' }, 401);

  const { results } = await env.DB
    .prepare('SELECT id, username, address, ip, created_at FROM users ORDER BY created_at DESC')
    .all();

  const lines = ['id,username,address,ip,created_at'];
  for (const r of results) {
    lines.push([r.id, r.username, r.address, r.ip, r.created_at].map(csvCell).join(','));
  }

  return new Response('\uFEFF' + lines.join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="registrations.csv"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function methodNotAllowed(allow) {
  return json({ ok: false, error: 'method-not-allowed' }, 405, { Allow: allow });
}

async function handleApi(request, env, url, cors) {
  if (request.method === 'OPTIONS') {
    if (!cors) return methodNotAllowed('GET, POST');
    return new Response(null, { status: 204, headers: cors });
  }

  try {
    const p = url.pathname;
    const m = request.method;
    let res;

    if (p === '/api/health') {
      res = m === 'GET' ? json({ ok: true, ts: new Date().toISOString() }) : methodNotAllowed('GET');
    } else if (p === '/api/register') {
      res = m === 'POST' ? await handleRegister(request, env) : methodNotAllowed('POST');
    } else if (p === '/api/users') {
      res = m === 'GET' ? await handleList(request, env, url) : methodNotAllowed('GET');
    } else if (p === '/api/export.csv') {
      res = m === 'GET' ? await handleExport(request, env, url) : methodNotAllowed('GET');
    } else {
      res = json({ ok: false, error: 'not-found' }, 404);
    }

    return cors ? withHeaders(res, cors) : res;
  } catch (err) {
    // 详细错误只留在日志里，不回给调用方
    console.error('[api]', (err && err.stack) || String(err));
    return json({ ok: false, error: 'server-error' }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url, cors);
    }

    const res = await env.ASSETS.fetch(request);
    return withHeaders(res, SECURITY_HEADERS);
  }
};
