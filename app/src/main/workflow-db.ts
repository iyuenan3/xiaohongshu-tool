// 工作流持久化 (M7). 沿用 better-sqlite3 同步 API, 复用 db.ts singleton.

import { getDb } from './db';

export type FailReason =
  | 'llm_timeout'
  | 'llm_5xx'
  | 'quota_exhausted'
  | 'llm_auth'
  | 'rate_limited'
  | 'xhs_reject'
  | 'network'
  | 'user_abort'
  | 'unknown';

export type RunStatus = 'running' | 'success' | 'partial' | 'failed' | 'missed' | 'aborted' | 'disabled_by_failure';

export interface Schedule {
  type: 'daily' | 'weekly' | 'interval' | 'manual' | 'once';
  hour?: number;        // daily / weekly: 0-23
  minute?: number;      // daily / weekly: 0-59
  weekday?: number;     // weekly: 0-6 (Sun=0)
  interval_hours?: number;  // interval: 1-72
  at?: number;          // once: 执行的绝对时间戳 (ms). 自主运营计划行动用
  jitter_min?: number;  // ±N min 随机抖动, default 10
  tz: string;            // 创建时 Intl.DateTimeFormat().resolvedOptions().timeZone, e.g. 'Asia/Shanghai'
}

export interface Workflow {
  id: number;
  template_id: string;
  name: string;
  params: string;        // JSON
  schedule: string;      // JSON of Schedule
  enabled: number;       // 0/1
  deleted_at: number | null;
  fail_count: number;
  created_at: number;
  updated_at: number;
  last_fire_at: number | null;
  next_fire_at: number | null;
}

export interface StepLogEntry {
  step: string;
  at: number;
  result?: unknown;
  error?: string;
}

export interface WorkflowRun {
  id: number;
  workflow_id: number;
  started_at: number;
  finished_at: number | null;
  status: RunStatus;
  fail_reason: FailReason | null;
  summary: string | null;
  steps_log: string | null;  // JSON of StepLogEntry[]
  error: string | null;
}

// ============ workflows ============

export function listWorkflows(includeDeleted = false): Workflow[] {
  const sql = includeDeleted
    ? `SELECT * FROM workflows ORDER BY id DESC`
    : `SELECT * FROM workflows WHERE deleted_at IS NULL ORDER BY id DESC`;
  return getDb().prepare(sql).all() as Workflow[];
}

export function listEnabledWorkflows(): Workflow[] {
  return getDb()
    .prepare(`SELECT * FROM workflows WHERE enabled = 1 AND deleted_at IS NULL ORDER BY id`)
    .all() as Workflow[];
}

export function getWorkflow(id: number): Workflow | null {
  const row = getDb().prepare(`SELECT * FROM workflows WHERE id = ?`).get(id) as Workflow | undefined;
  return row ?? null;
}

export interface CreateWorkflowInput {
  template_id: string;
  name: string;
  params: unknown;
  schedule: Schedule;
  enabled?: boolean;
}

export function createWorkflow(input: CreateWorkflowInput): Workflow {
  const now = Date.now();
  const enabled = input.enabled === false ? 0 : 1;
  const result = getDb()
    .prepare(
      `INSERT INTO workflows (template_id, name, params, schedule, enabled, fail_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(input.template_id, input.name, JSON.stringify(input.params), JSON.stringify(input.schedule), enabled, now, now);
  return getWorkflow(Number(result.lastInsertRowid))!;
}

export function updateWorkflow(id: number, patch: Partial<Workflow>): void {
  const now = Date.now();
  const fields: string[] = ['updated_at = ?'];
  const args: unknown[] = [now];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id' || k === 'created_at' || k === 'updated_at') continue;
    if (v === undefined) continue;  // 跳过 undefined, 防 better-sqlite3 把它当 NULL 违反 NOT NULL 列
    fields.push(`${k} = ?`);
    args.push(v);
  }
  args.push(id);
  getDb().prepare(`UPDATE workflows SET ${fields.join(', ')} WHERE id = ?`).run(...args);
}

export function softDeleteWorkflow(id: number): void {
  const now = Date.now();
  getDb().prepare(`UPDATE workflows SET deleted_at = ?, enabled = 0, updated_at = ? WHERE id = ?`).run(now, now, id);
}

// ============ workflow_runs ============

export function insertRun(input: {
  workflow_id: number;
  started_at: number;
  status: RunStatus;
  summary?: string;
  fail_reason?: FailReason | null;
}): number {
  const result = getDb()
    .prepare(
      `INSERT INTO workflow_runs (workflow_id, started_at, status, summary, fail_reason, steps_log)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.workflow_id, input.started_at, input.status, input.summary ?? null, input.fail_reason ?? null, '[]');
  return Number(result.lastInsertRowid);
}

export function updateRun(id: number, patch: Partial<WorkflowRun>): void {
  const fields: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id') continue;
    if (v === undefined) continue;
    fields.push(`${k} = ?`);
    args.push(v);
  }
  if (fields.length === 0) return;
  args.push(id);
  getDb().prepare(`UPDATE workflow_runs SET ${fields.join(', ')} WHERE id = ?`).run(...args);
}

export function appendRunStep(runId: number, step: StepLogEntry): void {
  const row = getDb().prepare(`SELECT steps_log FROM workflow_runs WHERE id = ?`).get(runId) as { steps_log: string } | undefined;
  if (!row) return;
  const arr = JSON.parse(row.steps_log || '[]') as StepLogEntry[];
  arr.push(step);
  getDb().prepare(`UPDATE workflow_runs SET steps_log = ? WHERE id = ?`).run(JSON.stringify(arr), runId);
}

export function listRuns(workflowId: number, limit = 50): WorkflowRun[] {
  return getDb()
    .prepare(`SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?`)
    .all(workflowId, limit) as WorkflowRun[];
}

// ============ appConfig ============

export function getConfig(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM appConfig WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setConfig(key: string, value: string): void {
  getDb().prepare(`INSERT OR REPLACE INTO appConfig (key, value) VALUES (?, ?)`).run(key, value);
}
