// 工作流模板注册表 (M7 P1: 仅 daily_like_comment, P2 加 4 个).

import { dailyLikeComment } from './daily-like-comment';

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
  [dailyLikeComment.id]: dailyLikeComment,
};

export interface TemplateMeta {
  id: string;
  name: string;
  emoji: string;
  description: string;
  paramsSchema: ParamSchema;
}

export function listTemplateMetas(): TemplateMeta[] {
  return Object.values(TEMPLATES).map((t) => ({
    id: t.id,
    name: t.name,
    emoji: t.emoji,
    description: t.description,
    paramsSchema: t.paramsSchema,
  }));
}
