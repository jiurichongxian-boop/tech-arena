-- 参赛者登记表：姓名 + 居住地址；IP 和注册时间由服务端在提交时写入
-- 注意：如果库里已存在旧版 users 表（字段不同），先手动执行 DROP TABLE users; 再应用本文件
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  address    TEXT NOT NULL,
  dup_key    TEXT NOT NULL,
  ip         TEXT,
  created_at TEXT NOT NULL
);

-- 唯一性：按 dup_key（JS 侧小写化后的 username|address）去重
-- 不直接用 lower(username) 是因为 SQLite 的 lower() 只处理 ASCII，西里尔/中文不生效
CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_dup_key ON users (dup_key);

-- 后台按时间倒序翻页
CREATE INDEX IF NOT EXISTS idx_users_created ON users (created_at DESC);

-- 限流查询
CREATE INDEX IF NOT EXISTS idx_users_ip ON users (ip, created_at);
