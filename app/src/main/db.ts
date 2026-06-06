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

    -- 笔记级数据快照 (P2 反馈闭环): 每次采集自己每条笔记的互动数, 用于"哪类内容数据好"分析 + 回灌 Planner
    CREATE TABLE IF NOT EXISTS note_snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      taken_at    INTEGER NOT NULL,         -- unix ms
      feed_id     TEXT NOT NULL,            -- 笔记 id
      title       TEXT,                     -- 笔记标题 (快照时)
      liked       INTEGER,                  -- 点赞
      collected   INTEGER,                  -- 收藏
      comments    INTEGER,                  -- 评论
      shared      INTEGER,                  -- 分享
      raw         TEXT                      -- 该 feed 原始 JSON (截断)
    );
    CREATE INDEX IF NOT EXISTS idx_note_snapshots_feed ON note_snapshots(feed_id, taken_at DESC);
    CREATE INDEX IF NOT EXISTS idx_note_snapshots_taken_at ON note_snapshots(taken_at DESC);

    -- ===== 自主运营系统 (M1+): 画像 / 计划 / 行动项 / 待审发布 =====
    CREATE TABLE IF NOT EXISTS operating_profile (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      direction   TEXT NOT NULL,                  -- 赛道/方向
      persona     TEXT,                           -- 人设调性
      constraints TEXT NOT NULL,                  -- JSON: {pub_per_week, active_hours, taboo[], tone, free_text}
      asset_tags  TEXT NOT NULL DEFAULT '[]',     -- JSON string[]: 绑定素材 tag 范围
      status      TEXT NOT NULL DEFAULT 'draft',  -- draft / active / paused
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operating_plan (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id   INTEGER NOT NULL,
      generated_at INTEGER NOT NULL,
      horizon_days INTEGER NOT NULL,
      status       TEXT NOT NULL DEFAULT 'draft', -- draft(待审) / active / done / superseded
      raw          TEXT NOT NULL,                 -- Planner 输出完整 JSON
      rationale    TEXT                           -- AI 规划理由
    );
    CREATE INDEX IF NOT EXISTS idx_operating_plan_profile ON operating_plan(profile_id, generated_at DESC);

    CREATE TABLE IF NOT EXISTS plan_action (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id      INTEGER NOT NULL,
      scheduled_at INTEGER NOT NULL,
      type         TEXT NOT NULL,                 -- browse / interact / publish
      spec         TEXT NOT NULL,                 -- JSON: 该行动参数
      workflow_id  INTEGER,                       -- 实例化后绑定的 workflow
      status       TEXT NOT NULL DEFAULT 'pending', -- pending / scheduled / done / skipped
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plan_action_plan ON plan_action(plan_id, scheduled_at);

    CREATE TABLE IF NOT EXISTS pending_publish (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_action_id INTEGER,
      title          TEXT,
      content        TEXT,
      images         TEXT,                         -- JSON: 素材 id 列表
      tags           TEXT,                         -- JSON: 标签
      ai_reason      TEXT,                         -- AI 为何这样写
      schedule_at    INTEGER,                      -- 计划发布时间
      status         TEXT NOT NULL DEFAULT 'pending', -- pending/approved/rejected/expired/published
      created_at     INTEGER NOT NULL,
      decided_at     INTEGER,
      published_feed_id TEXT             -- P2/A1: 真发后回写的小红书笔记 id (用于关联表现)
    );
    CREATE INDEX IF NOT EXISTS idx_pending_publish_status ON pending_publish(status, created_at DESC);
  `);

  // 老 db 升级: 给 media_assets 加 tags/description/analyzed 列 (SQLite 不支持 ALTER IF NOT EXISTS)
  const cols = inst.prepare('PRAGMA table_info(media_assets)').all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('tags')) inst.exec(`ALTER TABLE media_assets ADD COLUMN tags TEXT DEFAULT '[]'`);
  if (!names.has('description')) inst.exec(`ALTER TABLE media_assets ADD COLUMN description TEXT`);
  if (!names.has('analyzed')) inst.exec(`ALTER TABLE media_assets ADD COLUMN analyzed INTEGER DEFAULT 0`);
  // 老 db 升级: pending_publish 加 published_feed_id (P2/A1)
  const ppCols = inst.prepare('PRAGMA table_info(pending_publish)').all() as Array<{ name: string }>;
  if (!new Set(ppCols.map((c) => c.name)).has('published_feed_id')) {
    inst.exec(`ALTER TABLE pending_publish ADD COLUMN published_feed_id TEXT`);
  }
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
