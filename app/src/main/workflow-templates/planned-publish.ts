// planned_publish 模板 (M4): 自主运营的发布闸门。
// 到点不直接发布, 而是先选图 → 以实选图片为核心让 LLM 现场生成文案 (图片驱动, 根治图文不符)
// → 把标题/正文写进 pending_publish 待审队列, 用户在「自主运营」确认/编辑后才真发 (分级自主度: 发布要人在环)。
// 设计见 AIREADME/DESIGN-autonomous-operation.md §7。

import { listAssets, shuffleArray, type MediaAsset } from '../assets';
import { insertPending, getRecentlyUsedAssetIds, getActiveProfile, getAction, completeActionAndMaybePlan } from '../operating-db';
import { findTaboo, activeTaboo } from '../content-guard';
import { extractFirstJsonObject } from '../planner';
import { isAutoPilotEnabled, autoPublishWindowMs, autoPublishWindowHours } from '../auto-pilot';
import type { Template, ExecHelpers, ExecResult } from './index';

// 选图排除「近 N 天已用过」的素材, 实现轮换 (用户反馈: 素材固定不换新)
const RECENT_USED_DAYS = 14;

// 镜像 Go pkg/xhsutil/title.go CalcTitleLength 的口径: 按 UTF-16 单元, 非 ASCII 计 2 字节、ASCII 计 1,
// 结果 ceil(字节/2)。emoji = 2 单元 = 4 字节 = 2 字。TS 侧截断必须用同一口径, 否则「码点 ≤20 但
// Go 判 >20」的标题会确定性发布失败, 全自动路径白烧 3 次重试 (深度 review 确证)。
function xhsTitleLen(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) bytes += s.charCodeAt(i) > 127 ? 2 : 1;
  return Math.ceil(bytes / 2);
}

// 按码点逐个累加 (不劈 emoji 代理对), 到 xhsTitleLen 上限为止
function truncateByXhsLen(s: string, maxLen: number): string {
  if (xhsTitleLen(s) <= maxLen) return s;
  let out = '';
  for (const ch of s) {
    if (xhsTitleLen(out + ch) > maxLen) break;
    out += ch;
  }
  return out;
}

function parseTags(v: unknown): string[] {
  return String(v ?? '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
}

function safeTags(a: MediaAsset): string[] {
  try {
    const t = JSON.parse(a.tags || '[]');
    return Array.isArray(t) ? (t as string[]) : [];
  } catch {
    return [];
  }
}

// 按标签从素材库挑图 (空标签=全库)。三重反「固定选图」:
//   1. 排除近 14 天拟稿/发布用过的 (不足 limit 再回填已用的)
//   2. 已分析 (有标签描述, 图片驱动文案可用) 优先
//   3. 组内 Fisher-Yates 洗牌 (listAssets 排序确定性, 不洗牌同标签永远同一批)
function pickPublishAssets(tags: string[], limit: number): MediaAsset[] {
  const all = listAssets();
  const matched = tags.length ? all.filter((a) => safeTags(a).some((t) => tags.includes(t))) : all;
  if (!matched.length) return [];
  const used = new Set(getRecentlyUsedAssetIds(RECENT_USED_DAYS));
  const byPreference = (arr: MediaAsset[]): MediaAsset[] => [
    ...shuffleArray(arr.filter((a) => a.analyzed === 1)),
    ...shuffleArray(arr.filter((a) => a.analyzed !== 1)),
  ];
  const fresh = matched.filter((a) => !used.has(a.id));
  const stale = matched.filter((a) => used.has(a.id));
  return [...byPreference(fresh), ...byPreference(stale)].slice(0, limit);
}

// 图片驱动文案: 文案必须从实选图片长出来, 而不是 Planner 几天前对着标签文字想象出来的
const IMAGE_DRAFT_SYSTEM = `你是小红书博主, 根据【实际配图】写一篇图文相符的笔记。
要求:
- 文案必须紧扣配图内容, 以图片描述为事实依据, 不编造图里看不到的具体细节 (物体/颜色/场景)
- 标题 16-20 字 (绝不超过 20 字, 平台硬限), 情绪词+关键词, 口语化
- 正文 300-500 字: 痛点共鸣 → 自然引入 → 真实体验细节 → 降低期望的总结, 真实不夸大, 少 emoji
- 严格 JSON 输出: {"title": "...", "content": "..."}, 不要 markdown 代码块, 不要其他文字`;

interface ImageDraft {
  title: string;
  content: string;
}

function buildImageDraftPrompt(
  theme: string,
  refTitle: string,
  refContent: string,
  picked: MediaAsset[],
): string {
  const L: string[] = [];
  const profile = getActiveProfile();
  if (profile) {
    L.push(`# 账号方向\n${profile.direction}${profile.persona ? `\n人设/调性: ${profile.persona}` : ''}`);
  }
  const taboo = activeTaboo();
  if (taboo.length) L.push(`# 禁忌 (绝不出现)\n${taboo.join('、')}`);
  L.push(`# 本篇主题 (计划拟定的方向, 供参考)\n${theme || refTitle || '(未指定, 以图片内容为准)'}`);
  if (refTitle || refContent) {
    L.push(`# 初稿 (几天前按标签想象写的, 仅参考选题方向, 细节以实际配图为准)\n标题: ${refTitle}\n正文: ${refContent.slice(0, 300)}`);
  }
  L.push('# 实际配图 (按顺序, 文案必须与这些图片相符)');
  picked.forEach((a, i) => {
    const tags = safeTags(a).join(',');
    L.push(`图${i + 1}: [${tags || '无标签'}] ${a.description || a.filename}`);
  });
  L.push('请据以上信息输出 JSON。');
  return L.join('\n\n');
}

function parseImageDraft(raw: string): ImageDraft | null {
  const jsonStr = extractFirstJsonObject(raw);
  if (!jsonStr) return null;
  try {
    const obj = JSON.parse(jsonStr) as Partial<ImageDraft>;
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    const content = typeof obj.content === 'string' ? obj.content.trim() : '';
    if (!title || !content) return null;
    return { title, content };
  } catch {
    return null;
  }
}

export const plannedPublish: Template = {
  id: 'planned_publish',
  name: '运营发布(待审)',
  emoji: '✍️',
  description: '自主运营到点拟稿: 先选图再以图生成文案, 进待审队列, 用户确认才真发 (分级自主度).',
  paramsSchema: {
    title: { type: 'string', default: '', label: '标题' },
    content: { type: 'string', default: '', label: '正文' },
    asset_tags: { type: 'string', default: '', label: '素材标签 (选图)' },
    note_tags: { type: 'string', default: '', label: '笔记话题标签' },
    theme: { type: 'string', default: '', label: '主题 (AI 理由)' },
    plan_action_id: { type: 'int', default: 0, label: '行动项 id' },
  },
  async execute(params: Record<string, unknown>, helpers: ExecHelpers): Promise<ExecResult> {
    let title = String(params.title ?? '').trim();
    let content = String(params.content ?? '').trim();
    const assetTags = parseTags(params.asset_tags);
    const noteTags = parseTags(params.note_tags);
    const theme = String(params.theme ?? '').trim();
    const planActionId = Number(params.plan_action_id) || null;

    if (!title) {
      // 空标题不拟稿 = 该发布行动永远不会有 approve/reject 回写 → 必须在这里标终态,
      // 否则 plan_action 永卡 scheduled → plan 永 active → P3 每周自动激活被顶死 (深度 review 确证, v0.9.6 存量洞)
      if (planActionId) completeActionAndMaybePlan(planActionId, 'skipped');
      return { status: 'partial', summary: '⚠️ 标题为空, 跳过待审' };
    }

    const picked = pickPublishAssets(assetTags, 6);
    const images = picked.map((a) => a.id);

    // 图片驱动文案: 选到的图里至少 1 张有描述/标签才重写 (全无标签时重写只会更瞎编, 保留初稿)
    let rewritten = false;
    const describable = picked.filter((a) => a.analyzed === 1 && (a.description || safeTags(a).length));
    if (describable.length) {
      try {
        const raw = await helpers.callLLM({
          system: IMAGE_DRAFT_SYSTEM,
          user: buildImageDraftPrompt(theme, title, content, picked),
          max_tokens: 1500,
          timeout_ms: 90 * 1000,
        });
        const draft = parseImageDraft(raw);
        if (draft) {
          title = draft.title;
          content = draft.content;
          rewritten = true;
          helpers.log({ step: 'image_draft', result: { title, imageCount: images.length } });
        } else {
          helpers.log({ step: 'image_draft', error: '输出解析失败, 回退计划初稿' });
        }
      } catch (e) {
        // 手动停止必须冒泡 (review HIGH): 吞掉会照常 insertPending, 全自动模式下把用户已停止的稿子武装上自动发
        if ((e as Error).message?.includes('已手动停止')) throw e;
        // 其它 LLM 失败不阻塞拟稿: 回退 Planner 初稿 (行为同旧版)
        helpers.log({ step: 'image_draft', error: `${(e as Error).message.slice(0, 80)}, 回退计划初稿` });
      }
    } else if (images.length) {
      helpers.log({ step: 'image_draft', result: { skipped: '实选图片均无标签描述, 保留计划初稿 (建议素材库补分析)' } });
    }

    // 小红书硬限: 标题 20 字 (按 Go CalcTitleLength 口径) / 正文 1000 字。超限真发会被 Go 端拦,
    // 全自动路径会白烧 3 次重试才转人工 (review MED)。
    title = truncateByXhsLen(title, 20);
    if (content.length > 950) content = [...content].slice(0, 950).join('');

    // 计划被 supersede 的竞态窗口 (90s LLM 调用把窗口从微秒放大到分钟级): 用户在本次拟稿进行中激活了
    // 新计划 → 本行动已被标 skipped、旧待审稿已作废 → 此时再落库会产出「作废方向 + 已武装自动发」的孤儿稿。
    if (planActionId) {
      const action = getAction(planActionId);
      if (action && (action.status === 'skipped' || action.status === 'done')) {
        return { status: 'partial', summary: '⚠️ 所属计划已被替换/完结, 本次拟稿作废' };
      }
    }

    // E3 内容护栏: 拟稿即标记禁忌词命中 (用户审核可见; 批准时 publish-gate 会硬拦)
    const tabooHits = findTaboo(`${title}\n${content}`, activeTaboo());
    const reason = theme;
    // P3 全自动「审核窗口自动发」: 开关开时给拟稿标 auto_publish_at=now+窗口, 窗口内未否决则 scheduler 扫描过护栏自动发。
    const autoPilot = isAutoPilotEnabled();
    const autoPublishAt = autoPilot ? Date.now() + autoPublishWindowMs() : null;
    insertPending({
      plan_action_id: planActionId,
      title,
      content,
      images,
      tags: noteTags,
      ai_reason: tabooHits.length ? `⚠️ 触禁忌词[${tabooHits.join('、')}]，请修改 ｜ ${reason}` : reason,
      auto_publish_at: autoPublishAt,
    });
    helpers.log({ step: 'pending_publish', result: { title, imageCount: images.length, rewritten, tabooHits, autoPilot } });
    const warn = tabooHits.length ? ` ⚠️含禁忌词[${tabooHits.join('、')}]` : '';
    const tail = autoPilot
      ? ` — 全自动: ${autoPublishWindowHours()}h 内未否决将自动发布`
      : ' — 去「自主运营」确认发布';
    return {
      status: 'partial',
      summary: `✍️ 已拟稿待审: ${title}${images.length ? ` (${images.length} 图${rewritten ? ', 文案已按实选图生成' : ''})` : ' (无匹配素材, 待补图)'}${warn}${tail}`,
    };
  },
};
