// planned_publish 模板 (M4): 自主运营的发布闸门。
// 到点不直接发布, 而是按计划选图 + 把标题/正文写进 pending_publish 待审队列,
// 用户在「自主运营」确认/编辑后才真发 (分级自主度: 发布要人在环)。
// 设计见 AIREADME/DESIGN-autonomous-operation.md §7.

import { listAssets } from '../assets';
import { insertPending } from '../operating-db';
import type { Template, ExecHelpers, ExecResult } from './index';

function parseTags(v: unknown): string[] {
  return String(v ?? '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
}

// 按标签从素材库挑图, 返回素材 id 列表 (空标签=全部最近的)
function pickAssetIds(tags: string[], limit: number): string[] {
  const all = listAssets();
  const matched = tags.length
    ? all.filter((a) => {
        const at = JSON.parse(a.tags || '[]') as string[];
        return at.some((t) => tags.includes(t));
      })
    : all;
  return matched.slice(0, limit).map((a) => a.id);
}

export const plannedPublish: Template = {
  id: 'planned_publish',
  name: '运营发布(待审)',
  emoji: '✍️',
  description: '自主运营到点拟稿: 按计划选图 + 标题正文进待审队列, 用户确认才真发 (分级自主度).',
  paramsSchema: {
    title: { type: 'string', default: '', label: '标题' },
    content: { type: 'string', default: '', label: '正文' },
    asset_tags: { type: 'string', default: '', label: '素材标签 (选图)' },
    note_tags: { type: 'string', default: '', label: '笔记话题标签' },
    theme: { type: 'string', default: '', label: '主题 (AI 理由)' },
    plan_action_id: { type: 'int', default: 0, label: '行动项 id' },
  },
  async execute(params: Record<string, unknown>, helpers: ExecHelpers): Promise<ExecResult> {
    const title = String(params.title ?? '').trim();
    const content = String(params.content ?? '').trim();
    const assetTags = parseTags(params.asset_tags);
    const noteTags = parseTags(params.note_tags);
    const planActionId = Number(params.plan_action_id) || null;

    if (!title) return { status: 'partial', summary: '⚠️ 标题为空, 跳过待审' };

    const images = pickAssetIds(assetTags, 6);
    insertPending({
      plan_action_id: planActionId,
      title,
      content,
      images,
      tags: noteTags,
      ai_reason: String(params.theme ?? ''),
    });
    helpers.log({ step: 'pending_publish', result: { title, imageCount: images.length } });
    return {
      status: 'partial',
      summary: `✍️ 已拟稿待审: ${title}${images.length ? ` (${images.length} 图)` : ' (无匹配素材, 待补图)'} — 去「自主运营」确认发布`,
    };
  },
};
