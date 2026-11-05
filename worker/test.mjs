import worker from './src/index.js';

const rows = [];

class Stmt {
  constructor(sql, args = []) {
    this.sql = sql.replace(/\s+/g, ' ').trim();
    this.args = args;
  }
  bind(...args) {
    return new Stmt(this.sql, args);
  }
  async first(col) {
    const { results } = await this.all();
    const row = results[0];
    if (!row) return null;
    return col ? row[col] : row;
  }
  async all() {
    const s = this.sql;

    if (s.includes('AS u') && s.includes('AS e') && s.includes('AS p')) {
      const [u, e, p] = this.args;
      return {
        results: [{
          u: rows.filter((x) => x.username.toLowerCase() === String(u).toLowerCase()).length,
          e: rows.filter((x) => x.email.toLowerCase() === String(e).toLowerCase()).length,
          p: rows.filter((x) => x.phone === p).length
        }]
      };
    }

    if (s.includes('COUNT(*) AS n') && s.includes('ip_hash')) {
      const [ip, since] = this.args;
      return { results: [{ n: rows.filter((x) => x.ip_hash === ip && x.created_at > since).length }] };
    }

    if (s.includes('COUNT(*) AS n')) {
      return { results: [{ n: rows.length }] };
    }

    if (s.startsWith('SELECT id, surname, username, phone, email, created_at')) {
      const ordered = [...rows].reverse();
      const sliced = s.includes('LIMIT') ? ordered.slice(this.args[1], this.args[1] + this.args[0]) : ordered;
      return { results: sliced };
    }

    throw new Error('unhandled select: ' + s);
  }
  async run() {
    if (this.sql.includes('INSERT INTO users')) {
      const [surname, username, email, phone, ip_hash, ua, created_at] = this.args;
      const id = rows.length + 1;
      rows.push({ id, surname, username, email, phone, ip_hash, ua, created_at });
      return { success: true, meta: { last_row_id: id } };
    }
    throw new Error('unhandled run: ' + this.sql);
  }
}

const env = {
  ADMIN_TOKEN: 'testtoken',
  ASSETS: { fetch: async () => new Response('asset-ok', { status: 200 }) },
  DB: { prepare: (sql) => new Stmt(sql) }
};

let pass = 0;
let fail = 0;

async function check(label, req, expectStatus, assert) {
  const res = await worker.fetch(req, env);
  const text = await res.text();
  let ok = res.status === expectStatus;
  if (ok && assert) ok = assert(text, res);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  [${res.status}] ${text.slice(0, 100)}`);
  ok ? pass++ : fail++;
}

const reg = (body, ip = '1.1.1.1') =>
  new Request('https://x.dev/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, 'User-Agent': 'test' },
    body: JSON.stringify(body)
  });

const valid = { surname: '张', username: 'zhangsan', phone: '13800138000', email: 'zhang@example.com' };

await check('健康检查', new Request('https://x.dev/api/health'), 200, (t) => t.includes('"ok":true'));
await check('静态透传', new Request('https://x.dev/index.html'), 200, (t) => t === 'asset-ok');
await check('正常注册', reg(valid), 201, (t) => t.includes('"username":"zhangsan"'));
await check('用户名重复', reg({ ...valid, email: 'other@example.com', phone: '13900139000' }), 409, (t) => t.includes('已被占用'));
await check('邮箱重复', reg({ ...valid, username: 'lisi', phone: '13900139000' }), 409, (t) => t.includes('邮箱已注册'));
await check('手机号重复', reg({ ...valid, username: 'lisi', email: 'li@example.com' }), 409, (t) => t.includes('手机号已注册'));
await check('手机号非法', reg({ ...valid, username: 'wangwu', email: 'w@example.com', phone: '123' }, '2.2.2.2'), 400, (t) => t.includes('11 位'));
await check('用户名非法', reg({ ...valid, username: '1ab', email: 'w2@example.com', phone: '13700137000' }, '2.2.2.2'), 400, (t) => t.includes('字母开头'));
await check('邮箱非法', reg({ ...valid, username: 'wangwu', phone: '13700137000', email: 'nope' }, '2.2.2.2'), 400, (t) => t.includes('邮箱格式'));
await check('姓为空', reg({ ...valid, surname: '', username: 'wangwu', phone: '13700137000', email: 'w3@example.com' }, '2.2.2.2'), 400, (t) => t.includes('请填写姓'));
await check('未授权', new Request('https://x.dev/api/users'), 401);
await check('Bearer 读名单', new Request('https://x.dev/api/users', { headers: { Authorization: 'Bearer testtoken' } }), 200, (t) => t.includes('zhangsan'));
await check('CSV 导出', new Request('https://x.dev/api/export.csv?token=testtoken'), 200, (t) => t.includes('surname,username') && t.includes('张'));

for (let i = 0; i < 10; i++) {
  await worker.fetch(reg({ surname: '刷', username: 'bot' + i, email: `b${i}@x.com`, phone: '1360013600' + i }, '9.9.9.9'), env);
}
await check('限流触发', reg({ surname: '刷', username: 'botX', email: 'bx@x.com', phone: '13600136099' }, '9.9.9.9'), 429, (t) => t.includes('rate-limited'));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
