// 运营大脑 (M2). 据账号画像 + 近期数据 + 可用素材, 调 LLM 生成结构化运营计划 (browse/interact/publish).
// 方法论蒸馏自小红书运营专家 (内容配比 / 发布节奏 / 爆款结构 / 平台合规). 设计见 AIREADME/DESIGN-autonomous-operation.md.

import { net } from 'electron';
import log from 'electron-log/main';
import { licenseManager, type LlmConfig } from './license';
import {
  getActiveProfile, getLatestSnapshot, createPlan, insertActions,
  type OperatingProfile, type ProfileConstraints, type PlanActionType,
} from './operating-db';
import { listAssets, type MediaAsset } from './assets';

const PLANNER_MAX_TOKENS = 3000;
const PLANNER_TIMEOUT_MS = 90 * 1000;

const PLANNER_SYSTEM = `你是一位小红书资深运营操盘手，精通内容种草、账号养成与平台算法。
任务：根据【账号画像】【近期数据】【可用素材】，规划未来 N 天的运营行动，输出一份可执行的运营计划。

## 行动类型（只用这三种）
- browse：刷垂直内容（养号 + 找灵感 + 喂算法）。spec: { "keyword": 关键词, "count": 刷几篇(建议 20-40) }
- interact：给垂类内容点赞评论（涨权重 + 露出）。spec: { "keyword": 关键词, "like": 点赞数(≤10), "comment": 评论数(≤3) }
- publish：发布笔记。spec: { "theme": 主题, "asset_tags": 用哪类素材标签(从可用素材里选), "title": 标题(18-22字,情绪词+关键词,口语), "content": 正文(300-500字), "note_tags": 笔记话题标签数组(3-6个) }

## 运营方法论（务必遵守）
1. 内容配比：约 70% 垂类深耕 + 20% 蹭趋势 + 10% 强转化，不要每条都硬推。
2. 发布节奏：发布时段优先画像的活跃时段，否则晚 19:00-21:00 或午休 12:00-13:00。每周发布不超过画像上限。
3. 养号优先：开头几天多 browse + interact 养权重，别一上来猛发。
4. 爆款笔记结构：正文 = 痛点共鸣 → 自然引入 → 真实体验细节 → 降低期望的总结（适当提缺点更可信）。标题情绪词+关键词、口语化。
5. 真实感：基于真实体验，不夸大、不堆卖点、少 emoji。绝不碰画像里的禁忌。
6. 互动会全自动执行，发布会经用户审核，所以发布内容要完整可用（标题/正文/标签都拟好）。

## 频率红线（绝不超过）
- 发布：不超过画像的每周上限
- 单次互动：点赞 ≤10、评论 ≤3
- 别把同一天排得过密（browse+interact+publish 全堆像机器人）

## 输出格式（严格 JSON，不要任何额外文字，不要 markdown 代码块）
{
  "rationale": "一句话说明本期运营重点和节奏安排的理由",
  "actions": [
    { "day": 1, "time": "20:00", "type": "browse", "spec": { "keyword": "云南旅居", "count": 30 } },
    { "day": 2, "time": "21:00", "type": "publish", "spec": { "theme": "果园樱花", "asset_tags": ["樱花"], "title": "...", "content": "...", "note_tags": ["云南","慢生活"] } }
  ]
}
day 从 1 开始（1=今天），time 是 24 小时制 HH:MM。只输出 JSON。`;

interface PlannerAction {
  day: number;
  time: string;
  type: PlanActionType;
  spec: Record<string, unknown>;
}
interface PlannerOutput {
  rationale: string;
  actions: PlannerAction[];
}

export type GeneratePlanResult =
  | { ok: true; planId: number; actionsCount: number; rationale: string }
  | { ok: false; error: string };

export async function generatePlan(horizonDays = 7): Promise<GeneratePlanResult> {
  const profile = getActiveProfile();
  if (!profile) return { ok: false, error: '请先在「自主运营」配置账号画像' };
  const llm = await licenseManager.getActiveLlm();
  if (!llm) return { ok: false, error: 'LLM 未配置（激活码状态异常或 BYOK 为空）' };

  const userPrompt = buildContext(profile, horizonDays);
  log.info(`[planner] generating ${horizonDays}d plan for profile ${profile.id}`);

  let raw: string;
  try {
    raw = await callPlannerLLM(llm, PLANNER_SYSTEM, userPrompt);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`[planner] LLM call failed: ${msg}`);
    if (msg.includes('429')) return { ok: false, error: '本月 AI 额度可能已用尽，请联系客服' };
    if (e instanceof Error && e.name === 'AbortError') return { ok: false, error: 'AI 规划超时（90s），请重试' };
    return { ok: false, error: `AI 规划失败：${msg.slice(0, 80)}` };
  }

  const parsed = parsePlannerOutput(raw);
  if (!parsed || parsed.actions.length === 0) {
    log.warn(`[planner] parse failed, raw head: ${raw.slice(0, 200)}`);
    return { ok: false, error: 'AI 返回的计划格式无法解析，请重试' };
  }

  const plan = createPlan({
    profile_id: profile.id,
    horizon_days: horizonDays,
    raw: JSON.stringify(parsed),
    rationale: parsed.rationale,
  });
  insertActions(
    plan.id,
    parsed.actions.map((a) => ({ scheduled_at: dayTimeToTs(a.day, a.time), type: a.type, spec: a.spec })),
  );
  log.info(`[planner] plan ${plan.id} created with ${parsed.actions.length} actions`);
  return { ok: true, planId: plan.id, actionsCount: parsed.actions.length, rationale: parsed.rationale };
}

function buildContext(profile: OperatingProfile, horizonDays: number): string {
  const c = JSON.parse(profile.constraints || '{}') as ProfileConstraints;
  const snap = getLatestSnapshot();
  const assets = pickAssets(JSON.parse(profile.asset_tags || '[]') as string[]);
  const now = new Date();
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];

  const L: string[] = [];
  L.push('# 账号画像');
  L.push(`方向/赛道: ${profile.direction}`);
  if (profile.persona) L.push(`人设/调性: ${profile.persona}`);
  L.push(`每周发布上限: ${c.pub_per_week ?? 3} 条`);
  L.push(`活跃时段: ${c.active_hours || '未指定'}`);
  if (c.tone) L.push(`内容调性关键词: ${c.tone}`);
  if (c.taboo?.length) L.push(`禁忌(绝不涉及): ${c.taboo.join('、')}`);
  if (c.free_text) L.push(`补充说明: ${c.free_text}`);

  L.push('\n# 近期账号数据');
  if (snap) {
    L.push(`粉丝 ${snap.fans ?? '?'} / 笔记 ${snap.notes_count ?? '?'} / 总获赞 ${snap.likes_total ?? '?'}`);
  } else {
    L.push('(暂无数据快照，按新号/养号策略规划)');
  }

  L.push('\n# 可用素材 (发布选图只能用这些，按标签匹配)');
  if (assets.length) {
    for (const a of assets.slice(0, 30)) {
      const tags = (JSON.parse(a.tags || '[]') as string[]).join(',');
      L.push(`- [${tags || '无标签'}] ${a.description || a.filename}`);
    }
  } else {
    L.push('(素材库为空或无匹配标签的素材；若要安排 publish，请在 rationale 提醒用户先补素材，且 publish 数量要少或为 0)');
  }

  L.push('\n# 规划要求');
  L.push(`今天是${weekday}。请规划未来 ${horizonDays} 天 (day 1 = 今天) 的运营行动。`);
  L.push('严格按 system 要求的 JSON 格式输出，只输出 JSON。');
  return L.join('\n');
}

function pickAssets(tags: string[]): MediaAsset[] {
  const all = listAssets();
  if (!tags.length) return all;
  return all.filter((a) => {
    const at = JSON.parse(a.tags || '[]') as string[];
    return at.some((t) => tags.includes(t));
  });
}

function parsePlannerOutput(raw: string): PlannerOutput | null {
  let txt = raw.trim();
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) txt = fence[1].trim();
  const s = txt.indexOf('{');
  const e = txt.lastIndexOf('}');
  if (s >= 0 && e > s) txt = txt.slice(s, e + 1);
  try {
    const obj = JSON.parse(txt) as PlannerOutput;
    if (!obj || !Array.isArray(obj.actions)) return null;
    obj.actions = obj.actions.filter(
      (a) =>
        a && typeof a.day === 'number' && typeof a.time === 'string' &&
        ['browse', 'interact', 'publish'].includes(a.type) && a.spec && typeof a.spec === 'object',
    );
    if (typeof obj.rationale !== 'string') obj.rationale = '';
    return obj;
  } catch {
    return null;
  }
}

function dayTimeToTs(day: number, time: string): number {
  const [h, m] = time.split(':').map((x) => parseInt(x, 10));
  const d = new Date();
  d.setDate(d.getDate() + (day - 1));
  d.setHours(isNaN(h) ? 20 : h, isNaN(m) ? 0 : m, 0, 0);
  return d.getTime();
}

async function callPlannerLLM(llm: LlmConfig, system: string, user: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLANNER_TIMEOUT_MS);
  try {
    const resp = await net.fetch(`${llm.base_url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.api_key}` },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: PLANNER_MAX_TOKENS,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`LLM ${resp.status}: ${t.slice(0, 200)}`);
    }
    const json = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content?.trim() ?? '';
    if (!content) throw new Error('LLM 返回空内容');
    return content;
  } finally {
    clearTimeout(timeout);
  }
}
