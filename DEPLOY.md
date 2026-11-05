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

`worker/wrangler.jsonc`<u> 已经配好了 `assets.directory = ../demo/public` 和 `d1_databases.binding = DB`，  
所以 `demo/` 不需要单独部署，也不需</u>要改前端里的 `fetch('/api/register')`。

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

注意 `wrangler.jsonc` 里的 `assets.directory` 是 `../demo/public`，构建时必须能看到仓库根的 `demo/`，  
所以 Root directory 只能是 `worker`，不能是仓库根目录（否则 `main: src/index.js` 找不到）。

Secret 和 D1 绑定在控制台的 Settings 里配置一次即可，之后 push 就自动上线。

---

## 五、几个容易踩的点

- **`database_id` 还是占位符就 deploy** → 报 `Couldn't find a D1 DB with that name`。先把真实 id 填进去。
- **`wrangler dev` 端口冲突** → `npx wrangler dev --port 8790`；macOS 上 8787 常被占用。
- **改完前端不生效** → 静态资源是随 Worker 一起发布的，必须重新 `npm run deploy`，不是改完文件就自动上线。
- **`?token=` 会出现在访问日志里** → 只适合内部小工具。要更稳妥就换成 `Authorization: Bearer <token>`，  
  接口已经同时支持这两种方式。
- **免费额度**：Workers 每天 10 万请求、D1 每天 500 万行读，这个注册页远远用不满。
- **数据备份**：`npm run db:sql` 看最近 20 条；全量导出 CSV 走 `/api/export.csv?token=...`。
- **删除测试数据**：  
  `npx wrangler d1 execute techarena-leads --remote --command "DELETE FROM users"`

---

## 六、这次改了哪些文件

| 文件                       | 改动                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `worker/wrangler.jsonc`  | 已有配置核对通过（assets + D1 + observability），只需填 `database_id`                            |
| `worker/schema.sql`      | 补 `uniq_users_username`（大小写不敏感唯一索引），防止并发下用户名重复                                     |
| `worker/package.json`    | 加 `db:init` / `db:init:remote` / `db:sql` / `tail` 脚本，`wrangler` 进 devDependencies |
| `worker/.dev.vars`       | 本地开发用的 `ADMIN_TOKEN`（已 gitignore）                                                  |
| `demo/public/index.html` | 去掉写死的 `?token=demo-token`，改成点链接时询问令牌并记住；离线文案改为通用提示                                 |
| `.gitignore`             | 忽略 `node_modules/`、`.wrangler/`、`.dev.vars`、`demo/data/`                           |
