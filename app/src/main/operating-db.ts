// 自主运营系统持久化 (M1+). 复用 db.ts singleton, 同步 better-sqlite3 (仿 workflow-db.ts).
// 画像(profile) CRUD 在 M1 完成; 计划/行动项/待审发布的类型先定义, CRUD 留对应 milestone (M2/M3/M4).

import { getDb } from './db';

// ============ 运营画像 (operating_profile) ============

export interface ProfileConstraints {
  pub_per_week: number;     // 周发布上限 (条)
  active_hours: string;     // 活跃时段, e.g. "19:00-21:00"
  taboo: string[];          // 禁忌词/话题
  tone: string;             // 调性, e.g. "真实、治愈、慢生活"
  free_text?: string;       // 自由补充 (引导式表单之外的额外说明)
}

export type ProfileStatus = 'draft' | 'active' | 'paused';

export interface OperatingProfile {
  id: number;
  direction: string;        // 赛道/方向
  persona: string | null;   // 人设调性
  constraints: string;      // JSON of ProfileConstraints
  asset_tags: string;       // JSON string[]
  status: ProfileStatus;
  created_at: number;
  updated_at: number;
}

// ============ 运营计划 (operating_plan) — M2 用 ============

export type PlanStatus = 'draft' | 'active' | 'done' | 'superseded';

export interface OperatingPlan {
  id: number;
  profile_id: number;
  generated_at: number;
  horizon_days: number;
  status: PlanStatus;
  raw: string;              // Planner 输出完整 JSON
  rationale: string | null;
}

// ============ 行动项 (plan_action) — M3 用 ============

export type PlanActionType = 'browse' | 'interact' | 'publish';
export type PlanActionStatus = 'pending' | 'scheduled' | 'done' | 'skipped';

export interface PlanAction {
  id: number;
  plan_id: number;
  scheduled_at: number;
  type: PlanActionType;
  spec: string;             // JSON
  workflow_id: number | null;
  status: PlanActionStatus;
  created_at: number;
}

// ============ 待审发布 (pending_publish) — M4 用 ============

export type PendingStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'published';

export interface PendingPublish {
  id: number;
  plan_action_id: number | null;
  title: string | null;
  content: string | null;
  images: string | null;    // JSON: 素材 id 列表
  tags: string | null;      // JSON
  ai_reason: string | null;
  schedule_at: number | null;
  status: PendingStatus;
  created_at: number;
  decided_at: number | null;
  published_feed_id: string | null; // P2/A1: 真发后回写的笔记 id
}

// ============ 画像 CRUD (M1) ============

export interface SaveProfileInput {
  direction: string;
  persona?: string | null;
  constraints: ProfileConstraints;
  asset_tags?: string[];
  status?: ProfileStatus;
}

export function createProfile(input: SaveProfileInput): OperatingProfile {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `INSERT INTO operating_profile (direction, persona, constraints, asset_tags, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.direction,
      input.persona ?? null,
      JSON.stringify(input.constraints),
      JSON.stringify(input.asset_tags ?? []),
      input.status ?? 'draft',
      now,
      now,
    );
  return getProfile(Number(result.lastInsertRowid))!;
}

export function updateProfile(id: number, patch: Partial<SaveProfileInput>): void {
  const now = Date.now();
  const fields: string[] = ['updated_at = ?'];
  const args: unknown[] = [now];
  if (patch.direction !== undefined) { fields.push('direction = ?'); args.push(patch.direction); }
  if (patch.persona !== undefined) { fields.push('persona = ?'); args.push(patch.persona); }
  if (patch.constraints !== undefined) { fields.push('constraints = ?'); args.push(JSON.stringify(patch.constraints)); }
  if (patch.asset_tags !== undefined) { fields.push('asset_tags = ?'); args.push(JSON.stringify(patch.asset_tags)); }
  if (patch.status !== undefined) { fields.push('status = ?'); args.push(patch.status); }
  args.push(id);
  getDb().prepare(`UPDATE operating_profile SET ${fields.join(', ')} WHERE id = ?`).run(...args);
}

export function getProfile(id: number): OperatingProfile | null {
  const row = getDb().prepare(`SELECT * FROM operating_profile WHERE id = ?`).get(id) as OperatingProfile | undefined;
  return row ?? null;
}

/** 当前生效画像: 优先 status=active 的最新一条, 否则最新一条 (M1 简化: 通常只有一个画像). */
export function getActiveProfile(): OperatingProfile | null {
  const active = getDb()
    .prepare(`SELECT * FROM operating_profile WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`)
    .get() as OperatingProfile | undefined;
  if (active) return active;
  const latest = getDb()
    .prepare(`SELECT * FROM operating_profile ORDER BY updated_at DESC LIMIT 1`)
    .get() as OperatingProfile | undefined;
  return latest ?? null;
}

export function listProfiles(): OperatingProfile[] {
  return getDb().prepare(`SELECT * FROM operating_profile ORDER BY updated_at DESC`).all() as OperatingProfile[];
}

export function setProfileStatus(id: number, status: ProfileStatus): void {
  getDb().prepare(`UPDATE operating_profile SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), id);
}

// ============ 计划 CRUD (M2) ============

export interface CreatePlanInput {
  profile_id: number;
  horizon_days: number;
  raw: string;          // Planner 输出完整 JSON
  rationale?: string;
}

export function createPlan(input: CreatePlanInput): OperatingPlan {
  const now = Date.now();
  const result = getDb()
    .prepare(`INSERT INTO operating_plan (profile_id, generated_at, horizon_days, status, raw, rationale)
              VALUES (?, ?, ?, 'draft', ?, ?)`)
    .run(input.profile_id, now, input.horizon_days, input.raw, input.rationale ?? null);
  return getPlan(Number(result.lastInsertRowid))!;
}

export function getPlan(id: number): OperatingPlan | null {
  const row = getDb().prepare(`SELECT * FROM operating_plan WHERE id = ?`).get(id) as OperatingPlan | undefined;
  return row ?? null;
}

export function getLatestPlan(profileId?: number): OperatingPlan | null {
  const row = profileId
    ? getDb().prepare(`SELECT * FROM operating_plan WHERE profile_id = ? ORDER BY generated_at DESC LIMIT 1`).get(profileId)
    : getDb().prepare(`SELECT * FROM operating_plan ORDER BY generated_at DESC LIMIT 1`).get();
  return (row as OperatingPlan | undefined) ?? null;
}

export function setPlanStatus(id: number, status: PlanStatus): void {
  getDb().prepare(`UPDATE operating_plan SET status = ? WHERE id = ?`).run(status, id);
}

export function listPlansByStatus(status: PlanStatus): OperatingPlan[] {
  return getDb().prepare(`SELECT * FROM operating_plan WHERE status = ?`).all(status) as OperatingPlan[];
}

// ============ 行动项 CRUD (M2/M3) ============

export function insertActions(
  planId: number,
  actions: Array<{ scheduled_at: number; type: PlanActionType; spec: unknown }>,
): void {
  const now = Date.now();
  const stmt = getDb().prepare(
    `INSERT INTO plan_action (plan_id, scheduled_at, type, spec, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
  );
  const tx = getDb().transaction((rows: Array<{ scheduled_at: number; type: PlanActionType; spec: unknown }>) => {
    for (const a of rows) stmt.run(planId, a.scheduled_at, a.type, JSON.stringify(a.spec), now);
  });
  tx(actions);
}

export function listActions(planId: number): PlanAction[] {
  return getDb().prepare(`SELECT * FROM plan_action WHERE plan_id = ? ORDER BY scheduled_at`).all(planId) as PlanAction[];
}

export function updateActionStatus(id: number, status: PlanActionStatus, workflowId?: number): void {
  if (workflowId !== undefined) {
    getDb().prepare(`UPDATE plan_action SET status = ?, workflow_id = ? WHERE id = ?`).run(status, workflowId, id);
  } else {
    getDb().prepare(`UPDATE plan_action SET status = ? WHERE id = ?`).run(status, id);
  }
}

// ============ 数据快照读取 (M2 Planner 输入) ============

export interface AccountSnapshot {
  taken_at: number;
  nickname: string | null;
  fans: number | null;
  follows: number | null;
  notes_count: number | null;
  likes_total: number | null;
}

export function getLatestSnapshot(): AccountSnapshot | null {
  const row = getDb()
    .prepare(`SELECT taken_at, nickname, fans, follows, notes_count, likes_total FROM data_snapshots ORDER BY taken_at DESC LIMIT 1`)
    .get() as AccountSnapshot | undefined;
  return row ?? null;
}

// 运营报告 (D): 近 N 条账号快照, 升序 (旧→新) 便于画趋势.
export function getSnapshotTrend(limit = 30): AccountSnapshot[] {
  const rows = getDb()
    .prepare(`SELECT taken_at, nickname, fans, follows, notes_count, likes_total FROM data_snapshots ORDER BY taken_at DESC LIMIT ?`)
    .all(limit) as AccountSnapshot[];
  return rows.reverse();
}

// ============ 笔记级表现读取 (P2 反馈闭环 → 回灌 Planner) ============

export interface NotePerf {
  feed_id: string;
  title: string | null;
  liked: number | null;
  collected: number | null;
  comments: number | null;
  taken_at: number;
}

// 最近一次采集批次里, 按点赞降序的前 N 条笔记 (note_metrics_snapshot 同批 taken_at 相同).
export function getLatestNotePerformance(limit = 8): NotePerf[] {
  const latest = getDb().prepare(`SELECT MAX(taken_at) AS m FROM note_snapshots`).get() as { m: number | null };
  if (!latest?.m) return [];
  return getDb()
    .prepare(
      `SELECT feed_id, title, liked, collected, comments, taken_at FROM note_snapshots
       WHERE taken_at = ? ORDER BY (liked IS NULL), liked DESC LIMIT ?`,
    )
    .all(latest.m, limit) as NotePerf[];
}

// ============ 待审发布 CRUD (M4) ============

export interface InsertPendingInput {
  plan_action_id?: number | null;
  title: string;
  content: string;
  images: string[];   // 素材 id 列表
  tags: string[];
  ai_reason?: string;
  schedule_at?: number | null;
}

export function insertPending(input: InsertPendingInput): PendingPublish {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `INSERT INTO pending_publish (plan_action_id, title, content, images, tags, ai_reason, schedule_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      input.plan_action_id ?? null, input.title, input.content,
      JSON.stringify(input.images), JSON.stringify(input.tags),
      input.ai_reason ?? null, input.schedule_at ?? null, now,
    );
  return getPending(Number(result.lastInsertRowid))!;
}

export function getPending(id: number): PendingPublish | null {
  const row = getDb().prepare(`SELECT * FROM pending_publish WHERE id = ?`).get(id) as PendingPublish | undefined;
  return row ?? null;
}

export function listPending(status: PendingStatus = 'pending'): PendingPublish[] {
  return getDb().prepare(`SELECT * FROM pending_publish WHERE status = ? ORDER BY created_at DESC`).all(status) as PendingPublish[];
}

export function updatePendingStatus(id: number, status: PendingStatus): void {
  getDb().prepare(`UPDATE pending_publish SET status = ?, decided_at = ? WHERE id = ?`).run(status, Date.now(), id);
}

// P2/A1: 真发后回写笔记 id (best-effort, 用于关联该 AI 拟稿笔记的后续表现)
export function setPublishedFeedId(id: number, feedId: string): void {
  getDb().prepare(`UPDATE pending_publish SET published_feed_id = ? WHERE id = ?`).run(feedId, id);
}

export function updatePendingContent(
  id: number,
  patch: { title?: string; content?: string; images?: string[]; tags?: string[] },
): void {
  const fields: string[] = [];
  const args: unknown[] = [];
  if (patch.title !== undefined) { fields.push('title = ?'); args.push(patch.title); }
  if (patch.content !== undefined) { fields.push('content = ?'); args.push(patch.content); }
  if (patch.images !== undefined) { fields.push('images = ?'); args.push(JSON.stringify(patch.images)); }
  if (patch.tags !== undefined) { fields.push('tags = ?'); args.push(JSON.stringify(patch.tags)); }
  if (!fields.length) return;
  args.push(id);
  getDb().prepare(`UPDATE pending_publish SET ${fields.join(', ')} WHERE id = ?`).run(...args);
}
