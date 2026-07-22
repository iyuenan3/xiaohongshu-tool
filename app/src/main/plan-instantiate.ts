// 计划实例化 (M3). 把运营计划的行动项落成可调度的工作流, 接入现有 WorkflowScheduler.
//   - interact (点赞评论) → keyword_like_comment 工作流 + once 一次性调度 (到点自动执行)
//   - browse (纯浏览养号) → daily_browse 工作流 + once 调度 (到点逐条点开停留, 不写操作)
//   - publish (发布) → planned_publish 工作流 + once 调度 (到点拟稿进待审, 用户确认才发)
// 设计见 AIREADME/DESIGN-autonomous-operation.md §6/§7.

import log from 'electron-log/main';
import type { WorkflowScheduler } from './workflow-scheduler';
import { createWorkflow, softDeleteWorkflow, listWorkflows, updateWorkflow } from './workflow-db';
import { getPlan, listActions, updateActionStatus, setPlanStatus, listPlansByStatus, listPendingByAction, rejectPendingIfPending, clearAutoPublishAt } from './operating-db';
import { listAssets } from './assets';

// 过期宽限: 生成计划与激活是两个独立动作、可相隔任意时长。激活时 scheduled_at 可能已过
// (最常见: day-1 最早那槽生成时被 floor 到 now+5min, 用户几分钟后才激活)。若原样下发, scheduler
// 会静默判 missed + once 停用 + 不补跑、UI 仍显示"已排" → 行动悄悄丢失。
//   - 已过 ≤30min: 顺延到 now+60s 补跑 (救"稍晚激活刚错过"那条)
//   - 已过 >30min: 视为过期跳过 (避免隔天激活把大量过去行动一次性顺延成洪峰)
const STALE_GRACE_MS = 30 * 60 * 1000;
const CATCHUP_DELAY_MS = 60 * 1000;
function resolveFireAt(scheduledAt: number, now: number): number | null {
  if (scheduledAt >= now) return scheduledAt; // 未来: 原样
  if (now - scheduledAt <= STALE_GRACE_MS) return now + CATCHUP_DELAY_MS; // 刚过: 顺延补跑
  return null; // 过期太久: 跳过
}

// P2 反馈闭环: 激活运营 = 开始收集反馈数据。确保账号级 + 笔记级两个采集器在每日跑 (幂等)。
// 没有定期采集就没有时序数据 → Planner buildContext 的「近期账号数据 / 笔记表现」为空 → 闭环不自转。
function ensureFeedbackCollectors(scheduler: WorkflowScheduler, tz: string): number {
  const COLLECTORS = [
    { template_id: 'daily_data_snapshot', name: '📊 数据快照(自动)' },
    { template_id: 'note_metrics_snapshot', name: '📈 笔记数据采集(自动)' },
  ];
  const existing = listWorkflows(); // 非删除
  let created = 0;
  for (const c of COLLECTORS) {
    const ex = existing.find((w) => w.template_id === c.template_id);
    if (ex) {
      // 已有但曾连续失败被自动停用 → 重激活计划时复活 (否则反馈闭环永久静默断裂, 重激活也不恢复)
      if (!ex.enabled) {
        updateWorkflow(ex.id, { enabled: 1, fail_count: 0 });
        scheduler.rescheduleOne(ex.id);
        created++;
      }
      continue;
    }
    const wf = createWorkflow({
      template_id: c.template_id,
      name: c.name,
      params: {},
      schedule: { type: 'daily', hour: 23, minute: 30, jitter_min: 20, tz }, // 每日 23:30±20min 收尾采集当天数据
      enabled: true,
    });
    scheduler.rescheduleOne(wf.id);
    created++;
  }
  return created;
}

interface InteractSpec {
  keyword?: string;
  like?: number;
  comment?: number;
}

interface BrowseSpec {
  keyword?: string;
  count?: number;
}

interface PublishSpec {
  theme?: string;
  title?: string;
  content?: string;
  asset_tags?: string[];
  asset_group?: string; // 用户反馈 0719: 指定素材分组则整组发布 (优先于 asset_tags)
  note_tags?: string[];
}

export interface ActivatePlanResult {
  ok: boolean;
  created: number;   // 实例化的互动 + 浏览工作流数 (interact + browse)
  skipped: number;   // 跳过的行动数 (空关键词的 interact / 未知类型)
  staleSkipped: number; // 因时刻已过 (>30min) 跳过的行动数
  pendingPublish: number; // 留待审核的发布数
  assetWarning?: string; // E3 素材枯竭: 发布数 > 素材数时的提醒
  error?: string;
}

export function activatePlan(planId: number, scheduler: WorkflowScheduler): ActivatePlanResult {
  const plan = getPlan(planId);
  if (!plan) return { ok: false, created: 0, skipped: 0, staleSkipped: 0, pendingPublish: 0, error: '计划不存在' };
  // 幂等: 已激活的计划不重复实例化 (防连点 / 重复 IPC)
  if (plan.status === 'active') {
    return { ok: false, created: 0, skipped: 0, staleSkipped: 0, pendingPublish: 0, error: '此计划已激活, 如需重排请重新生成计划' };
  }

  // 清理之前 active 的计划: 取消其调度中的工作流 + 标 superseded, 防新旧两套并行跑
  for (const old of listPlansByStatus('active')) {
    if (old.id === planId) continue;
    for (const oa of listActions(old.id)) {
      if (oa.status === 'scheduled' && oa.workflow_id) {
        softDeleteWorkflow(oa.workflow_id);
        scheduler.cancelOne(oa.workflow_id);
        updateActionStatus(oa.id, 'skipped');
      }
      // 作废旧计划已拟好、仍待审的发布稿: 否则全自动会把作废方向的旧稿到点自动发出 (账号安全)
      for (const p of listPendingByAction(oa.id)) {
        clearAutoPublishAt(p.id);     // 先去武装 (即便否决竞态也不再自动发)
        rejectPendingIfPending(p.id); // 再否决移出待审 (条件仅 pending, 不误伤在途 publishing)
      }
    }
    setPlanStatus(old.id, 'superseded');
  }

  const actions = listActions(planId);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = Date.now();

  // P2: 激活即开启反馈闭环数据采集 (幂等)
  const collectorsCreated = ensureFeedbackCollectors(scheduler, tz);
  if (collectorsCreated) log.info(`[plan-instantiate] ensured ${collectorsCreated} feedback collector(s)`);
  let created = 0;
  let skipped = 0;
  let staleSkipped = 0;
  let pendingPublish = 0;

  for (const a of actions) {
    if (a.status !== 'pending') continue;

    if (a.type === 'interact') {
      let spec: InteractSpec = {};
      try {
        spec = JSON.parse(a.spec) as InteractSpec;
      } catch {
        /* spec 解析失败, 当空 */
      }
      const keyword = (spec.keyword || '').trim();
      if (!keyword) {
        updateActionStatus(a.id, 'skipped');
        skipped++;
        continue;
      }
      const fireAt = resolveFireAt(a.scheduled_at, now);
      if (fireAt === null) {
        updateActionStatus(a.id, 'skipped');
        staleSkipped++;
        continue;
      }
      // 点赞数与评论数分别下发 (模板分别尊重; comment=0 → 只点赞不评论, 尊重 Planner 意图)
      const likeN = Math.min(Math.max(spec.like ?? 0, 0), 5);   // 模板硬上限点赞 5 防风控
      const commentN = Math.min(Math.max(spec.comment ?? 0, 0), 3); // 评论硬上限 3
      const topN = Math.max(likeN, 1); // 至少点 1 篇 (评论篇是点赞篇子集, 需有载体)
      const wf = createWorkflow({
        template_id: 'keyword_like_comment',
        name: `[运营] 互动「${keyword}」`,
        params: { keyword, sort: 'general', top_n: topN, comment_n: commentN, comment_style: 'praise', plan_action_id: a.id },
        schedule: { type: 'once', at: fireAt, jitter_min: 5, tz },
        enabled: true,
      });
      scheduler.rescheduleOne(wf.id);
      updateActionStatus(a.id, 'scheduled', wf.id);
      created++;
    } else if (a.type === 'browse') {
      // 纯浏览养号: 实例化成 daily_browse 工作流 (once 调度), 到点逐条点开停留, 不点赞不评论
      let spec: BrowseSpec = {};
      try {
        spec = JSON.parse(a.spec) as BrowseSpec;
      } catch {
        /* spec 解析失败, 当空 (空关键词 = 刷首页) */
      }
      const keyword = (spec.keyword || '').trim();
      const fireAt = resolveFireAt(a.scheduled_at, now);
      if (fireAt === null) {
        updateActionStatus(a.id, 'skipped');
        staleSkipped++;
        continue;
      }
      // 浏览数落在 [1,20] (模板硬上限 20; 停留 15-45s/条, 过多会拖长串行调度)
      const topN = Math.min(Math.max(spec.count ?? 8, 1), 20);
      const wf = createWorkflow({
        template_id: 'daily_browse',
        name: keyword ? `[运营] 浏览「${keyword}」` : '[运营] 刷首页养号',
        params: { keyword, sort: 'general', top_n: topN, plan_action_id: a.id },
        schedule: { type: 'once', at: fireAt, jitter_min: 5, tz },
        enabled: true,
      });
      scheduler.rescheduleOne(wf.id);
      updateActionStatus(a.id, 'scheduled', wf.id);
      created++;
    } else if (a.type === 'publish') {
      // 发布: 实例化成 planned_publish 工作流 (once 调度), 到点拟稿进待审队列, 用户确认才发
      let spec: PublishSpec = {};
      try {
        spec = JSON.parse(a.spec) as PublishSpec;
      } catch {
        /* ignore */
      }
      const fireAt = resolveFireAt(a.scheduled_at, now);
      if (fireAt === null) {
        updateActionStatus(a.id, 'skipped');
        staleSkipped++;
        continue;
      }
      const wf = createWorkflow({
        template_id: 'planned_publish',
        name: `[运营] 发布「${spec.theme || spec.title || '笔记'}」`,
        params: {
          // 全部经 String()/Array.isArray 守卫: parsePlannerOutput 不校验 spec 内字段类型,
          // LLM 若把 asset_group 输出成数组/数字, 裸 .trim()/.join 会抛 TypeError → 整个 activatePlan 崩、
          // 计划永卡 pending 每次重试同点再抛 (review #2 死锁)。
          title: String(spec.title ?? ''),
          content: String(spec.content ?? ''),
          asset_tags: (Array.isArray(spec.asset_tags) ? spec.asset_tags : []).join(','),
          asset_group: String(spec.asset_group ?? '').trim(),
          note_tags: (Array.isArray(spec.note_tags) ? spec.note_tags : []).join(','),
          theme: String(spec.theme ?? ''),
          plan_action_id: a.id,
        },
        schedule: { type: 'once', at: fireAt, jitter_min: 5, tz },
        enabled: true,
      });
      scheduler.rescheduleOne(wf.id);
      updateActionStatus(a.id, 'scheduled', wf.id);
      pendingPublish++;
    } else {
      skipped++;
    }
  }

  setPlanStatus(planId, 'active');
  // E3 素材枯竭检测: 发布数多于素材数 → 提醒补素材 (绝不自动生图, 红线)
  let assetWarning: string | undefined;
  if (pendingPublish > 0) {
    const assetCount = listAssets().length;
    if (assetCount < pendingPublish) {
      assetWarning = `素材不足: ${pendingPublish} 条发布仅 ${assetCount} 张素材，建议先补素材库再逐条审核发布`;
      log.info(`[plan-instantiate] asset shortage: ${pendingPublish} publishes vs ${assetCount} assets`);
    }
  }
  log.info(`[plan-instantiate] plan ${planId} activated: ${created} interact+browse workflows, ${skipped} skipped, ${staleSkipped} stale-skipped, ${pendingPublish} publish pending`);
  return { ok: true, created, skipped, staleSkipped, pendingPublish, assetWarning };
}
