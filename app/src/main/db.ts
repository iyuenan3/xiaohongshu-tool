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
