# 对接 Cloudflare 部署说明

目标架构：**一个 Worker 同时托管前端静态页和 API**，前端和后端同域，不需要 Pages、不需要 CORS。

```
https://techarena.<你的账号>.workers.dev
├── /                     → demo/public/index.html   （Static Assets）
├── /api/register  POST   → Worker + D1
├── /api/users     GET    → Worker + D1（需 ADMIN_TOKEN）
├── /api/export.csv GET   → Worker + D1（需 ADMIN_TOKEN）
└── /api/health    GET    → Worker
```

`worker/wrangler.jsonc` 已经配好了 `assets.directory = ../demo/public` 和 `d1_databases.binding = DB`，  
所以 `demo/` 不需要单独部署，也不需要改前端里的 `fetch('/api/register')`。

---

## 零、命令在哪执行？控制台做什么？

### 打开终端（Windows）

按 `Win` 键 → 输入 `PowerShell`（或 `Windows Terminal`）→ 回车，然后：

```bash
cd C:\projects\tech-arena\worker
```

之后每条命令粘进去回车即可。命令必须在这个目录里执行，否则 `wrangler` 找不到 `wrangler.jsonc`。

### 每条命令对应的控制台操作

| 命令                                       | 在 Cloudflare 控制台怎么点                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `npx wrangler login`                     | **没有等价操作**。登录凭证只能在本机生成（浏览器弹授权页点 Allow）                                                  |
| `npx wrangler d1 create techarena-leads` | 侧边栏 `Storage & Databases`（存储和数据库）→ `D1 SQL Database` → `Create database`                |
| `npm run db:init:remote`                 | 进 D1 库 → `Console` 标签 → 把 `worker/schema.sql` 全文粘进去 → `Execute`                         |
| `npx wrangler secret put ADMIN_TOKEN`    | Worker → `Settings` → `Variables and Secrets` → `Add` → 类型选 **Secret**，名字 `ADMIN_TOKEN` |
| `npm run deploy`                         | **没有等价操作**。代码（含 `demo/public` 静态文件）只能由 wrangler 上传，或走 Git 自动部署                          |
| 绑域名（`routes` 配置）                         | Worker → `Settings` → `Domains & Routes` → `Add` → `Custom domain`                      |

结论：**建库、建表、加密钥、绑域名都能在控制台点完**，但「登录」和「上传代码」这两步绕不开 wrangler 或 Git 集成。  
不想在本地装 wrangler 的话，走第五节的 GitHub 自动部署，让 Cloudflare 的服务器替你跑 `wrangler deploy`。

> 控制台文案会微调，认关键词即可：D1 / Variables and Secrets / Domains & Routes。  
> 没有账号先去 <https://dash.cloudflare.com/sign-up> 注册，免费计划够用。

---

## 一、首次部署（5 步）

在 `worker/` 目录下执行：

```bash
cd worker
npm install

# 1. 登录（浏览器里点一下授权）
npx wrangler login

# 2. 建 D1 数据库，输出里会给你 database_id
npx wrangler d1 create techarena-leads
```

把上一步输出里的 `database_id` 填到 `worker/wrangler.jsonc` 的  
`REPLACE_WITH_YOUR_D1_ID` 位置（`database_name` 不用改）。

> 新的 wrangler 会追问一句 `Would you like Wrangler to add it on your behalf?`，  
> 选 **Yes** 就会自动把 `database_id` 写进 `wrangler.jsonc`，可以跳过手动编辑这步。

```bash
# 3. 建表（远程库）
npm run db:init:remote

# 4. 设置后台令牌（会提示粘贴，输入的内容不会进代码库）
npx wrangler secret put ADMIN_TOKEN

# 5. 发布
npm run deploy
```

发布成功后会打印 `https://techarena.<子域>.workers.dev`。验证：

```bash
curl https://techarena.<子域>.workers.dev/api/health
# {"ok":true,"ts":"..."}
```

打开首页 → 注册一条 → 点页面底部「查看已提交的数据」，粘贴刚才的 `ADMIN_TOKEN` 即可看到 JSON；  
或直接访问 `/api/export.csv?token=<ADMIN_TOKEN>` 下载 CSV。

> `ADMIN_TOKEN` 没有设置时，`/api/users` 和 `/api/export.csv` 一律 401，这是设计如此。

### 如果 `wrangler login` 卡住或打不开浏览器

走 API Token（不用浏览器回调，公司网络/代理环境更稳）：

1. 控制台右上角头像 → `My Profile` → `API Tokens` → `Create Token`
2. 选模板 **Edit Cloudflare Workers**，Account Resources 选你的账号，`Create`
3. 复制 token，在终端里设置（PowerShell）：

```powershell
$env:CLOUDFLARE_API_TOKEN = "你的token"
npx wrangler whoami      # 能看到账号就说明好了
```

Git Bash 用 `export CLOUDFLARE_API_TOKEN=...`。这个变量只对当前终端窗口有效，关掉就要重设。

---

## 二、日常本地开发

```bash
cd worker
npm run db:init     # 只第一次需要：建本地 D1 表
npm run dev         # http://localhost:8787，静态页 + API + 本地 D1
```

`npm run dev` 已经是完整链路（本地 SQLite 版的 D1 存在 `worker/.wrangler/`），  
`demo/server.js` 那个 Node 版 mock 现在只用于纯前端演示（`node demo/server.js`，数据落在 `demo/data/users.jsonl`），  
两者 API 行为一致，不用同时开。

本地密钥写在 `worker/.dev.vars`（已 gitignore），内容：

```
ADMIN_TOKEN=dev-token-local-only
```

---

## 三、绑自己的域名

`worker/wrangler.jsonc` 里加：

```jsonc
"routes": [
  { "pattern": "arena.example.com", "custom_domain": true }
]
```

域名必须已经托管在同一个 Cloudflare 账号下，`npm run deploy` 时会自动创建 DNS 记录和证书。  
这就是原来 GitHub Pages 那个 `CNAME` 的替代品。

---

## 四、从 GitHub 自动部署（可选）

Cloudflare 控制台 → Workers & Pages → Create → 连接 Git 仓库，填：

| 项              | 值                     |
| -------------- | --------------------- |
| Root directory | `worker`              |
| Build command  | `npm install`         |
| Deploy command | `npx wrangler deploy` |

注`意 wrangler.jsonc 里的 assets.directory 是 ../demo/public，构建时必须能看到仓库根的 demo/，
所以 Root directory 只`能是 `worker`，不能是仓库根目录（否则 `main: src/index.js` 找不到）。

Secret 和 D1 绑定在控制台的 Settings 里配置一次即可，之后 push 就自动上线。

---

## 五、几个容易踩的点

- **`database_id` 还是占位符就 deploy** → 报 `Couldn't find a D1 DB with that name`。先把真实 id 填进去。
- **`wrangler dev` 端口冲突** → `npx wrangler dev --port 8790`；macOS 上 8787 常被占用。
- **改完前端不生效** → 静态资源是随 Worker 一起发布的，必须重新 `npm run deploy`，不是改完文件就自动上线。
- **`?token=` 默认已关闭** → 后台接口只认 `Authorization: Bearer <token>`。URL 里的令牌会进浏览器历史、
  Referer 和 Cloudflare 访问日志，确实需要临时用（例如 curl 调试）时，给 Worker 加变量
  `ALLOW_QUERY_TOKEN=1` 才放行。
- **免费额度**：Workers 每天 10 万请求、D1 每天 500 万行读，这个注册页远远用不满。
- **数据备份**：`npm run db:sql` 看最近 20 条；全量导出 CSV 走 `/api/export.csv?token=...`。
- **删除测试数据**：  
  `npx wrangler d1 execute techarena-leads --remote --command "DELETE FROM users"`

---

## 六、接口安全（本次加固）

### 现在的默认行为

| 接口 | 谁能调 | 防护 |
| --- | --- | --- |
| `POST /api/register` | 任何人（这是公开报名表） | 8 KB 请求体上限、字段校验、同 IP 每小时 10 次、姓名+地址唯一索引 |
| `GET /api/users` | 只有带 `Authorization: Bearer <ADMIN_TOKEN>` 的人 | 令牌比较不提前返回（避免逐字节试探），其余一律 401 |
| `GET /api/export.csv` | 同上 | 同上 |
| `GET /api/health` | 任何人 | 只返回 `ok` 和时间戳 |

另外：`/api/*` 以外的响应都带 `Content-Security-Policy`、`X-Frame-Options: DENY`、
`Referrer-Policy: no-referrer`、`Permissions-Policy`、`Strict-Transport-Security`；
500 错误不再把 `err.message` 回给调用方（只写进 `wrangler tail`）。

> 注意：`wrangler.jsonc` 里 `assets.run_worker_first` 现在是 `true`。之前只写了 `["/api/*"]`，
> 那样静态页由资源层直接返回、**根本不经过 Worker**，所以安全响应头加不上。

### 生成一个足够强的后台令牌

```powershell
# PowerShell
-join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
```

```bash
# macOS / Linux / Git Bash
openssl rand -hex 32
```

然后 `npx wrangler secret put ADMIN_TOKEN` 粘贴进去。**不要**把令牌写进 `wrangler.jsonc`、
前端代码或 GitHub，因为它会进版本历史和构建日志。

### 建议在控制台再补两件事

1. **WAF 速率限制**（目前最有效的挡刷单手段）
   - 控制台 → `Security` → `WAF` → `Rate limiting rules`，对 `URI Path equals /api/register`
     设「每个 IP 每分钟 5 次」，动作 `Block`，持续 10 分钟
   - 顺手打开 `Security` → `Bots` → `Bot Fight Mode`
2. **后台接口再上一道身份验证**
   - `Zero Trust` → `Access` → `Applications`，把 `/api/users` 和 `/api/export.csv` 加进去，
     策略只允许你自己的邮箱。这样即使令牌泄露，陌生人也进不来。

### 前端后台入口的变化

页脚的「管理员入口」不再打开 `/api/users?token=...`，而是先用 `Authorization` 头请求数据，
再把结果渲染成一张表格（附「Download CSV」按钮）。令牌只留在 `localStorage['ta-admin-token']`，
不会出现在地址栏、浏览器历史和 Referer 里。

---

## 七、这次改了哪些文件

| 文件                       | 改动                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `worker/wrangler.jsonc`  | 已有配置核对通过（assets + D1 + observability），只需填 `database_id`                            |
| `worker/schema.sql`      | 补 `uniq_users_username`（大小写不敏感唯一索引），防止并发下用户名重复                                     |
| `worker/package.json`    | 加 `db:init` / `db:init:remote` / `db:sql` / `tail` 脚本，`wrangler` 进 devDependencies |
| `worker/.dev.vars`       | 本地开发用的 `ADMIN_TOKEN`（已 gitignore）                                                  |
| `demo/public/index.html` | 去掉写死的 `?token=demo-token`，改成点链接时询问令牌并记住；离线文案改为通用提示                                 |
| `.gitignore`             | 忽略 `node_modules/`、`.wrangler/`、`.dev.vars`、`demo/data/`                           |
| `worker/src/index.js`    | 鉴权换成令牌直比+定长时间比较、默认关闭 `?token=`、去掉放宽的 CORS、加安全响应头、500 不回显细节 |
| `worker/wrangler.jsonc`  | `assets.run_worker_first` 改为 `true`，让静态页也经过 Worker 才能加 CSP 等响应头                    |
| `demo/server.js`         | 本地 mock 同步 Bearer 鉴权                                                                    |
| `demo/public/index.html` | 后台入口改用 `Authorization` 请求并渲染表格                                                   |
