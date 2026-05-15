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
  `);
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
