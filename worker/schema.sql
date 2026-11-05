-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  surname     TEXT NOT NULL,
  username    TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT NOT NULL,
  ip_hash     TEXT,
  ua          TEXT,
  created_at  TEXT NOT NULL
);

-- 唯一性约束（大小写不敏感）
CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_username ON users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_email    ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_phone    ON users (phone);

-- 后台按时间倒序翻页
CREATE INDEX IF NOT EXISTS idx_users_created ON users (created_at DESC);

-- 限流查询
CREATE INDEX IF NOT EXISTS idx_users_ip ON users (ip_hash, created_at);
