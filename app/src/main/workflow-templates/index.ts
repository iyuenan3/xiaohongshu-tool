// 工作流模板注册表 (M7 P1: 仅 daily_like_comment, P2 加 4 个).

import { dailyLike } from './daily-like';
import { dailyComment } from './daily-comment';
import { dailyBrowse } from './daily-browse';
import { scheduledPublish } from './scheduled-publish';
import { dailyDataSnapshot } from './daily-data-snapshot';
import { noteMetricsSnapshot } from './note-metrics-snapshot';
import { keywordLikeComment } from './keyword-like-comment';
import { plannedPublish } from './planned-publish';
import { autoPlanGen } from './auto-plan-gen';

export interface Template {
  id: string;
  name: string;
  emoji: string;
  description: string;
  paramsSchema: ParamSchema;
  execute(params: Record<string, unknown>, helpers: ExecHelpers): Promise<ExecResult>;
}

export interface ParamSchema {
  [key: string]: { type: 'int' | 'enum' | 'string' | 'image_list'; min?: number; max?: number; options?: string[]; default?: unknown; label: string };
}

export interface ExecHelpers {
  callTool(tool: string, args: Record<string, unknown>): Promise<unknown>;
  callLLM(input: { system: string; user: string; max_tokens?: number }): Promise<string>;
  sleep(ms: number): Promise<void>;
  rand(min: number, max: number): number;
  log(entry: { step?: string; result?: unknown; error?: string }): void;
}

export interface ExecResult {
  status: 'success' | 'partial';
  fail_reason?: import('../workflow-db').FailReason | null;
  summary: string;
}

export const TEMPLATES: Record<string, Template> = {
  [dailyLike.id]: dailyLike,
  [dailyComment.id]: dailyComment,
  [dailyBrowse.id]: dailyBrowse,
  [keywordLikeComment.id]: keywordLikeComment,
  [scheduledPublish.id]: scheduledPublish,
  [dailyDataSnapshot.id]: dailyDataSnapshot,
  [noteMetricsSnapshot.id]: noteMetricsSnapshot,
  [plannedPublish.id]: plannedPublish,
  [autoPlanGen.id]: autoPlanGen,
};

// 自主运营内部模板, 不在「手动建工作流」列表出现 (仅供 scheduler 执行 + plan-instantiate / 开关管理)
const INTERNAL_TEMPLATE_IDS = new Set(['planned_publish', 'auto_plan_gen']);

export interface TemplateMeta {
  id: string;
  name: string;
  emoji: string;
  description: string;
  paramsSchema: ParamSchema;
}

export function listTemplateMetas(): TemplateMeta[] {
  return Object.values(TEMPLATES)
    .filter((t) => !INTERNAL_TEMPLATE_IDS.has(t.id))
    .map((t) => ({
      id: t.id,
      name: t.name,
      emoji: t.emoji,
      description: t.description,
      paramsSchema: t.paramsSchema,
    }));
}
