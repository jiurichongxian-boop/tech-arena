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

    if (s.includes('dup_key = ?')) {
      const [k] = this.args;
      return { results: [{ n: rows.filter((x) => x.dup_key === k).length }] };
    }

    if (s.includes('COUNT(*) AS n') && s.includes('ip = ?')) {
      const [ip, since] = this.args;
      return { results: [{ n: rows.filter((x) => x.ip === ip && x.created_at > since).length }] };
    }

    if (s.includes('COUNT(*) AS n')) {
      return { results: [{ n: rows.length }] };
    }

    if (s.startsWith('SELECT id, username, address, ip, created_at')) {
      const ordered = [...rows].reverse();
      const sliced = s.includes('LIMIT') ? ordered.slice(this.args[1], this.args[1] + this.args[0]) : ordered;
      return { results: sliced };
    }

    throw new Error('unhandled select: ' + s);
  }
  async run() {
    if (this.sql.includes('INSERT INTO users')) {
      const [username, address, dup_key, ip, created_at] = this.args;
      const id = rows.length + 1;
      rows.push({ id, username, address, dup_key, ip, created_at });
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

const valid = { username: 'Иванов Иван', address: 'ул. Ленина, д. 1, Москва' };

await check('健康检查', new Request('https://x.dev/api/health'), 200, (t) => t.includes('"ok":true'));
await check('静态透传', new Request('https://x.dev/index.html'), 200, (t) => t === 'asset-ok');
await check('正常登记', reg(valid), 201, (t) => t.includes('"username":"Иванов Иван"') && t.includes('"address"'));
await check('姓名+地址重复', reg(valid), 409, (t) => t.includes('duplicate'));
await check('同名不同地址可登记', reg({ ...valid, address: 'ул. Тверская, д. 2, Москва' }), 201);
await check('同地址不同姓名可登记', reg({ ...valid, username: 'Петров Пётр', address: 'ул. Ленина, д. 1, Москва' }), 201);
await check('姓名大小写不敏感去重', reg({ username: 'иванов иван', address: valid.address.toUpperCase() }), 409);
await check('姓名为空', reg({ username: '  ', address: valid.address }), 400, (t) => t.includes('name-required') && t.includes('full name'));
await check('地址为空', reg({ username: 'Сидоров', address: '' }), 400, (t) => t.includes('address-required') && t.includes('residential address'));
await check('地址太短', reg({ username: 'Сидоров', address: 'д.1' }), 400, (t) => t.includes('address-too-short') && t.includes('at least 5 characters'));
await check('姓名全是数字', reg({ username: '12345', address: 'ул. Ленина, д. 1' }, '3.3.3.3'), 400, (t) => t.includes('name-no-letters') && t.includes('digits or symbols'));
await check('地址超长', reg({ username: 'Сидоров', address: 'ул. '.repeat(60) }), 400, (t) => t.includes('address-too-long'));
await check('JSON 非法', new Request('https://x.dev/api/register', { method: 'POST', headers: { 'CF-Connecting-IP': '4.4.4.4' }, body: '{oops' }), 400);
await check('未授权', new Request('https://x.dev/api/users'), 401);
await check('Bearer 读名单', new Request('https://x.dev/api/users', { headers: { Authorization: 'Bearer testtoken' } }), 200, (t) => t.includes('Иванов') && t.includes('"ip":"1.1.1.1"'));
await check('CSV 导出', new Request('https://x.dev/api/export.csv', { headers: { Authorization: 'Bearer testtoken' } }), 200, (t) => t.includes('id,username,address,ip,created_at') && t.includes('Иванов'));
await check('URL 里的 token 默认无效', new Request('https://x.dev/api/export.csv?token=testtoken'), 401);
await check('错误 token 无效', new Request('https://x.dev/api/users', { headers: { Authorization: 'Bearer wrong' } }), 401);
await check('校验长度不一致的 token', new Request('https://x.dev/api/users', { headers: { Authorization: 'Bearer testtoken-x' } }), 401);
await check('方法不允许', new Request('https://x.dev/api/register', { method: 'GET' }), 405);
await check('跨域预检默认拒绝', new Request('https://x.dev/api/register', { method: 'OPTIONS' }), 405);
await check('配置接口', new Request('https://x.dev/api/config'), 200, (t) => t.includes('turnstileSiteKey'));

{
  const res = await worker.fetch(new Request('https://x.dev/'), env);
  const csp = res.headers.get('content-security-policy') || '';
  const ok = csp.includes("default-src 'self'") && res.headers.get('x-frame-options') === 'DENY'
    && res.headers.get('referrer-policy') === 'no-referrer' && (await res.text()) === 'asset-ok';
  console.log(`${ok ? 'PASS' : 'FAIL'}  页面安全响应头  [${res.status}] ${csp.slice(0, 40)}`);
  ok ? pass++ : fail++;
}

for (let i = 0; i < 10; i++) {
  await worker.fetch(reg({ username: 'Спамер ' + i, address: 'ул. Спама, д. ' + i }, '9.9.9.9'), env);
}
await check('限流触发', reg({ username: 'Спамер X', address: 'ул. Спама, д. 99' }, '9.9.9.9'), 429, (t) => t.includes('rate-limited'));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
