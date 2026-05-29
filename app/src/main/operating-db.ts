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
