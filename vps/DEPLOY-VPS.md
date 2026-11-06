# Tech Arena 报名站 — VPS 迁移部署指南

把 Cloudflare Worker + D1 迁到一台俄罗斯 VPS：**Node.js 24 + SQLite（node:sqlite，零 npm 依赖）+ Caddy（自动 HTTPS）**。
前端页面零改动——两份页面（`index.html`、`tech-arena-landing.html`）里的接口都是相对路径 `/api/...`，同源部署直接可用。

## 目录结构

```
vps/
├── server.js            # 后端（1:1 移植 worker/src/index.js 的全部逻辑）
├── tech-arena.service   # systemd 服务单元
├── Caddyfile            # HTTPS 反向代理
└── DEPLOY-VPS.md        # 本指南
上传后 VPS 上的结构：
/opt/tech-arena/
├── server.js
├── public/              # ← 从 demo/public/ 上传（index.html、tech-arena-landing.html 等）
└── data/                # SQLite 库文件所在，服务自动创建
```

`server.js` 已实现与 Worker 完全一致的行为：
- `POST /api/register`：校验（错误码一致：`name-required / name-no-letters / address-required ...`）、
  姓名+地址组合去重（JS 侧 `dup_key` 小写化，西里尔字母可用）、同 IP 每小时 10 次限流、8KB 请求体上限
- `GET /api/users` / `GET /api/export.csv`：`Authorization: Bearer <ADMIN_TOKEN>`
- `GET /api/health`：公开
- 静态文件：CSP / X-Frame-Options: DENY / HSTS 等安全头与 Worker 相同
- 去重、校验、限流都在 SQLite 里，重启不丢

---

## 一、VPS 上装 Node 24（必须 ≥24，node:sqlite 内置且免 flag）

```bash
# Debian/Ubuntu（NodeSource）
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # 应 ≥ v24.x
node -e "require('node:sqlite'); console.log('sqlite OK')"
```

## 二、上传代码

```bash
sudo mkdir -p /opt/tech-arena && sudo chown $USER /opt/tech-arena
# 本机执行（或用 WinSCP 拖拽）：
scp -r vps/server.js user@VPS_IP:/opt/tech-arena/
scp -r vps/tech-arena.service vps/Caddyfile user@VPS_IP:/opt/tech-arena/
scp -r demo/public user@VPS_IP:/opt/tech-arena/public
```

## 三、生成令牌并注册 systemd 服务

```bash
ssh user@VPS_IP
cd /opt/tech-arena
openssl rand -hex 24        # 复制输出，这就是 ADMIN_TOKEN

sudo cp tech-arena.service /etc/systemd/system/
sudo nano /etc/systemd/system/tech-arena.service   # 把 ADMIN_TOKEN=CHANGE_ME... 换成刚生成的
sudo systemctl daemon-reload
sudo systemctl enable --now tech-arena
systemctl status tech-arena --no-pager
curl -s http://127.0.0.1:8788/api/health    # {"ok":true,...}
```

## 四、装 Caddy（HTTPS 反向代理）

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy

sudo nano /etc/caddy/Caddyfile      # 把 your-domain.ru 换成真实域名
sudo systemctl reload caddy
```

前提：域名 A 记录已指向 VPS 公网 IP。Caddy 会自动签发并续期 Let's Encrypt 证书。

## 五、防火墙

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

Node 只监听 `127.0.0.1`，对外只暴露 80/443，全部流量走 Caddy。
`tech-arena.service` 里已设 `TRUST_PROXY=1`，服务端会从 `X-Forwarded-For` 取真实客户端 IP（限流和记录用）。

## 六、验证

```bash
curl -s https://your-domain.ru/api/health
curl -s -X POST https://your-domain.ru/api/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"Тест Тестов","address":"Москва, ул. Ленина 1"}'    # 201
# 同样的姓名+地址再发一次 → 409 duplicate
curl -s https://your-domain.ru/api/users -H "Authorization: Bearer <你的ADMIN_TOKEN>"
curl -s https://your-domain.ru/api/export.csv -H "Authorization: Bearer <你的ADMIN_TOKEN>" -o registrations.csv
```

浏览器打开 `https://your-domain.ru` → 报名流程全通；后台入口输入 ADMIN_TOKEN 即可看列表/导出 CSV。

## 七、（可选）把 D1 里的旧数据导进来

```bash
# 本机导出 D1 数据为 JSON：
npx wrangler d1 execute tech-arena --remote --json --command "SELECT username,address,ip,created_at FROM users" > d1-users.json
# 上传到 VPS 后导入（在 /opt/tech-arena 下执行）：
node -e "
const {DatabaseSync}=require('node:sqlite');
const rows=JSON.parse(require('fs').readFileSync('d1-users.json','utf8'))[0].results;
const db=new DatabaseSync('./data/tech-arena.db');
const ins=db.prepare('INSERT OR IGNORE INTO users (username,address,dup_key,ip,created_at) VALUES (?,?,?,?,?)');
let n=0;
for(const r of rows){ins.run(r.username,r.address,(r.username+'|'+r.address).toLowerCase(),r.ip,r.created_at);n++}
console.log('imported',n);
"
```

## 八、日常运维

```bash
sudo journalctl -u tech-arena -f          # 看日志
sudo systemctl restart tech-arena         # 重启（改 server.js 或环境变量后）
sudo systemctl reload caddy               # 改 Caddyfile 后
ls -la /opt/tech-arena/data/              # tech-arena.db / .db-wal / .db-shm
# 备份（WAL 模式下建议先 checkpoint）：
sudo -u www-data node -e "const{backup}=require('node:sqlite');const{DatabaseSync}=require('node:sqlite');backup(new DatabaseSync('/opt/tech-arena/data/tech-arena.db'),'/opt/tech-arena/data/backup.db').then(()=>console.log('done'))"
```

## 注意事项

1. **ADMIN_TOKEN 别提交进 git**：它只存在于 systemd 单元里。
2. **域名/合规**：VPS 供应商需在 Roskomnadzor 注册（Yandex Cloud、Timeweb、REG.RU、Selectel 等都已注册）。参赛者数据（姓名+住址）存俄境内反而符合 152-FZ 数据本地化要求。
3. **两份页面都要**：`demo/public` 里的 `index.html` 和 `tech-arena-landing.html` 是两套入口，都在 `public/` 里即可。
4. **Cloudflare 站可保留为备用**：俄罗斯用户访问 VPS 版，国外用户访问 Cloudflare 版；注意两套库数据不互通（VPS 版为主的话，定期把 D1 导出合并即可）。
