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

export type PendingStatus = 'pending' | 'publishing' | 'approved' | 'rejected' | 'expired' | 'published';

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
  auto_publish_at: number | null;   // P3: 全自动「审核窗口自动发」到点时刻 (null=仅人工; 非 null=窗口内未否决则自动发)
  auto_publish_attempts: number;    // P3: 自动发真发 API 连续失败次数 (达上限转人工, 防永久重试)
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

export function getAction(id: number): PlanAction | null {
  return (getDb().prepare(`SELECT * FROM plan_action WHERE id = ?`).get(id) as PlanAction | undefined) ?? null;
}

// 行动到终态回写 (成功跑完='done'; missed/failed/aborted='skipped'), 并在该计划所有行动都已离开
// pending/scheduled (done/skipped) 时把计划标 'done'。不回写的后果: 计划永远 active →
// auto_plan_gen 的 "无 active 才自动激活" 闸门永不放行 → P3 每周计划死锁。
export function completeActionAndMaybePlan(planActionId: number, status: 'done' | 'skipped' = 'done'): void {
  const a = getAction(planActionId);
  if (!a) return;
  if (a.status === 'done' || a.status === 'skipped') return; // 已终态, 幂等
  updateActionStatus(planActionId, status);
  const siblings = listActions(a.plan_id);
  const allTerminal = siblings.every((s) => s.id === planActionId || s.status === 'done' || s.status === 'skipped');
  if (allTerminal) {
    const plan = getPlan(a.plan_id);
    if (plan && plan.status === 'active') setPlanStatus(a.plan_id, 'done');
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

// ============ 去重上下文 (用户反馈: 每周计划选题几乎重复) ============

// 近期计划的 publish 选题 (主题+标题) + 近期拟稿标题, 供 Planner buildContext 注入「强制避开」段。
// 计划不分状态 (draft/superseded 也算: LLM 复刻的对象是它上次的输出, 不管有没有被激活)。
export function getRecentPublishTopics(maxPlans = 3, maxItems = 15): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (title?: string | null, theme?: string | null) => {
    const t = (title || '').trim();
    const th = (theme || '').trim();
    if (!t && !th) return;
    const line = t ? `「${t}」${th ? ` (主题: ${th})` : ''}` : `(主题: ${th})`;
    if (seen.has(line)) return;
    seen.add(line);
    out.push(line);
  };
  const plans = getDb()
    .prepare(`SELECT id FROM operating_plan ORDER BY generated_at DESC LIMIT ?`)
    .all(maxPlans) as Array<{ id: number }>;
  for (const p of plans) {
    const actions = getDb()
      .prepare(`SELECT spec FROM plan_action WHERE plan_id = ? AND type = 'publish'`)
      .all(p.id) as Array<{ spec: string }>;
    for (const a of actions) {
      try {
        const spec = JSON.parse(a.spec) as { title?: string; theme?: string };
        push(spec.title, spec.theme);
      } catch { /* spec 坏了跳过 */ }
    }
  }
  const drafts = getDb()
    .prepare(`SELECT title FROM pending_publish ORDER BY created_at DESC LIMIT 20`)
    .all() as Array<{ title: string | null }>;
  for (const d of drafts) push(d.title);
  return out.slice(0, maxItems);
}

// 近 N 天拟稿/发布用过的素材 id (排除 rejected/expired: 被否决的稿子素材视为没用过)。
// planned_publish 选图时先排除这些, 实现素材轮换 (用户反馈: 素材相对固定选不到新的)。
export function getRecentlyUsedAssetIds(days = 14): string[] {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = getDb()
    .prepare(
      `SELECT images FROM pending_publish
       WHERE created_at >= ? AND status IN ('pending','publishing','approved','published')`,
    )
    .all(since) as Array<{ images: string | null }>;
  const ids = new Set<string>();
  for (const r of rows) {
    try {
      for (const id of JSON.parse(r.images || '[]') as string[]) ids.add(id);
    } catch { /* ignore */ }
  }
  return [...ids];
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
  auto_publish_at?: number | null; // P3: 非 null = 全自动审核窗口到点时刻
}

export function insertPending(input: InsertPendingInput): PendingPublish {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `INSERT INTO pending_publish (plan_action_id, title, content, images, tags, ai_reason, schedule_at, auto_publish_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      input.plan_action_id ?? null, input.title, input.content,
      JSON.stringify(input.images), JSON.stringify(input.tags),
      input.ai_reason ?? null, input.schedule_at ?? null, input.auto_publish_at ?? null, now,
    );
  return getPending(Number(result.lastInsertRowid))!;
}

// P3: 列出到点该自动发的待审 (status=pending 且 auto_publish_at 已到), 供 scheduler 周期扫描。
export function listDueAutoPublish(now: number): PendingPublish[] {
  return getDb()
    .prepare(
      `SELECT * FROM pending_publish WHERE status = 'pending' AND auto_publish_at IS NOT NULL AND auto_publish_at <= ? ORDER BY auto_publish_at ASC`,
    )
    .all(now) as PendingPublish[];
}

// P3: 清掉 auto_publish_at → 该条退回"仅人工"(自动发失败/被否决时用, 防无限重试自动发)。
export function clearAutoPublishAt(id: number): void {
  getDb().prepare(`UPDATE pending_publish SET auto_publish_at = NULL WHERE id = ?`).run(id);
}

// P3: 一键停语义 = 关全自动时把所有待审的 auto_publish_at 清掉, 退回纯人工。
// 否则再次开启会把当初排队、窗口早已过的陈旧稿立刻自动发 (review: 再开=重新武装陈旧稿)。
export function clearAllAutoPublishAt(): void {
  getDb().prepare(`UPDATE pending_publish SET auto_publish_at = NULL WHERE status = 'pending' AND auto_publish_at IS NOT NULL`).run();
}

// P3: 原子抢占待发 (防重复发布竞态)。pending→publishing, 仅当当前确为 pending 才成功。
// 返回 true = 本调用抢到 (可继续真发); false = 已被并发的扫描/手动确认/拒绝抢走 (不可再发)。
export function claimPendingForPublish(id: number): boolean {
  const r = getDb()
    .prepare(`UPDATE pending_publish SET status = 'publishing' WHERE id = ? AND status = 'pending'`)
    .run(id);
  return r.changes === 1;
}

// P3: 真发失败 → 把 publishing 退回 pending (供重试/人工); 仅当确为 publishing 才退 (防覆盖已变状态)。
export function revertPublishingToPending(id: number): void {
  getDb().prepare(`UPDATE pending_publish SET status = 'pending' WHERE id = ? AND status = 'publishing'`).run(id);
}

// P3: 条件拒绝 (否决) — 仅当仍为 pending 才置 rejected。若已 publishing (真发在途) 则 changes=0,
// 不覆盖发布结果 (在途发布物理不可撤; 之后会落 published)。返回是否真否决到。
export function rejectPendingIfPending(id: number): boolean {
  const r = getDb()
    .prepare(`UPDATE pending_publish SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'`)
    .run(Date.now(), id);
  return r.changes === 1;
}

// P3: 启动恢复 — 进程在 claim 后、发布结果落库前崩溃会留下卡死的 'publishing' 行
// (listPending/listDue 都不选 → UI 看不到 + 永不再发)。启动时退回 pending + 清 auto_publish_at:
// 结果未知 (可能已发出), 故转纯人工让用户核对, 绝不自动重发 (防重复)。返回恢复条数。
export function recoverStuckPublishing(): number {
  const r = getDb()
    .prepare(`UPDATE pending_publish SET status = 'pending', auto_publish_at = NULL WHERE status = 'publishing'`)
    .run();
  return r.changes;
}

// P3: 自动发真发失败计数 +1, 返回新值 (达上限转人工)。
export function bumpAutoPublishAttempts(id: number): number {
  getDb().prepare(`UPDATE pending_publish SET auto_publish_attempts = auto_publish_attempts + 1 WHERE id = ?`).run(id);
  const row = getDb().prepare(`SELECT auto_publish_attempts AS n FROM pending_publish WHERE id = ?`).get(id) as { n?: number } | undefined;
  return row?.n ?? 0;
}

export function getPending(id: number): PendingPublish | null {
  const row = getDb().prepare(`SELECT * FROM pending_publish WHERE id = ?`).get(id) as PendingPublish | undefined;
  return row ?? null;
}

export function listPending(status: PendingStatus = 'pending'): PendingPublish[] {
  return getDb().prepare(`SELECT * FROM pending_publish WHERE status = ? ORDER BY created_at DESC`).all(status) as PendingPublish[];
}

// 某行动关联的、仍待审 (pending) 的发布稿 — supersede 旧计划时用来作废其稿子。
export function listPendingByAction(planActionId: number): PendingPublish[] {
  return getDb()
    .prepare(`SELECT * FROM pending_publish WHERE plan_action_id = ? AND status = 'pending'`)
    .all(planActionId) as PendingPublish[];
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
