// SQLite 持久化 (better-sqlite3 同步 API, 性能足够). 路径: userData/app.db.

import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'path';
import log from 'electron-log/main';

let db: Database.Database | null = null;

export function initDb(): Database.Database {
  if (db) return db;
  const path = join(app.getPath('userData'), 'app.db');
  log.info(`[db] init: ${path}`);
  const inst = new Database(path);
  inst.pragma('journal_mode = WAL');
  inst.pragma('synchronous = NORMAL');

  inst.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      title       TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT,
      tool_calls      TEXT,
      tool_call_id    TEXT,
      created_at      INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

    CREATE TABLE IF NOT EXISTS rate_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      action     TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rate_log ON rate_log(action, created_at);

    CREATE TABLE IF NOT EXISTS media_assets (
      id            TEXT PRIMARY KEY,
      filename      TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      size          INTEGER NOT NULL,
      source_url    TEXT,
      storage_path  TEXT NOT NULL,
      width         INTEGER,
      height        INTEGER,
      created_at    INTEGER NOT NULL,
      last_used_at  INTEGER NOT NULL,
      tags          TEXT DEFAULT '[]',
      description   TEXT,
      analyzed      INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_media_assets_last_used ON media_assets(last_used_at DESC);

    CREATE TABLE IF NOT EXISTS workflows (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id  TEXT NOT NULL,
      name         TEXT NOT NULL,
      params       TEXT NOT NULL,
      schedule     TEXT NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      deleted_at   INTEGER,
      fail_count   INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      last_fire_at INTEGER,
      next_fire_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_workflows_enabled ON workflows(enabled, deleted_at, next_fire_at);

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id  INTEGER NOT NULL,
      started_at   INTEGER NOT NULL,
      finished_at  INTEGER,
      status       TEXT NOT NULL,
      fail_reason  TEXT,
      summary      TEXT,
      steps_log    TEXT,
      error        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS appConfig (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS data_snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      taken_at    INTEGER NOT NULL,         -- unix ms
      red_id      TEXT,                     -- 小红书号 (可能变), 用来追多账号场景
      nickname    TEXT,                     -- 昵称
      fans        INTEGER,                  -- 粉丝数
      follows     INTEGER,                  -- 关注数
      notes_count INTEGER,                  -- 笔记数
      likes_total INTEGER,                  -- 总获赞数
      raw         TEXT                      -- 完整 my_profile JSON 备份
    );
    CREATE INDEX IF NOT EXISTS idx_data_snapshots_taken_at ON data_snapshots(taken_at DESC);
  `);

  // 老 db 升级: 给 media_assets 加 tags/description/analyzed 列 (SQLite 不支持 ALTER IF NOT EXISTS)
  const cols = inst.prepare('PRAGMA table_info(media_assets)').all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('tags')) inst.exec(`ALTER TABLE media_assets ADD COLUMN tags TEXT DEFAULT '[]'`);
  if (!names.has('description')) inst.exec(`ALTER TABLE media_assets ADD COLUMN description TEXT`);
  if (!names.has('analyzed')) inst.exec(`ALTER TABLE media_assets ADD COLUMN analyzed INTEGER DEFAULT 0`);
  db = inst;
  return inst;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('db not initialized');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
