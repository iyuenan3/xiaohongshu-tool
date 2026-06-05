// 计划实例化 (M3). 把运营计划的行动项落成可调度的工作流, 接入现有 WorkflowScheduler.
//   - interact (点赞评论) → keyword_like_comment 工作流 + once 一次性调度 (到点自动执行)
//   - browse (纯浏览养号) → daily_browse 工作流 + once 调度 (到点逐条点开停留, 不写操作)
//   - publish (发布) → planned_publish 工作流 + once 调度 (到点拟稿进待审, 用户确认才发)
// 设计见 AIREADME/DESIGN-autonomous-operation.md §6/§7.

import log from 'electron-log/main';
import type { WorkflowScheduler } from './workflow-scheduler';
import { createWorkflow, softDeleteWorkflow } from './workflow-db';
import { getPlan, listActions, updateActionStatus, setPlanStatus, listPlansByStatus } from './operating-db';

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
  note_tags?: string[];
}

export interface ActivatePlanResult {
  ok: boolean;
  created: number;   // 实例化的互动 + 浏览工作流数 (interact + browse)
  skipped: number;   // 跳过的行动数 (空关键词的 interact / 未知类型)
  staleSkipped: number; // 因时刻已过 (>30min) 跳过的行动数
  pendingPublish: number; // 留待审核的发布数
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
    }
    setPlanStatus(old.id, 'superseded');
  }

  const actions = listActions(planId);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = Date.now();
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
      // top_n 取 like/comment 的较大值, 落在 [1,5] (模板硬上限 5 防风控)
      const topN = Math.min(Math.max(spec.like ?? 0, spec.comment ?? 0, 1), 5);
      const wf = createWorkflow({
        template_id: 'keyword_like_comment',
        name: `[运营] 互动「${keyword}」`,
        params: { keyword, sort: 'general', top_n: topN, comment_style: 'praise' },
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
        params: { keyword, sort: 'general', top_n: topN },
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
          title: spec.title ?? '',
          content: spec.content ?? '',
          asset_tags: (spec.asset_tags ?? []).join(','),
          note_tags: (spec.note_tags ?? []).join(','),
          theme: spec.theme ?? '',
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
  log.info(`[plan-instantiate] plan ${planId} activated: ${created} interact+browse workflows, ${skipped} skipped, ${staleSkipped} stale-skipped, ${pendingPublish} publish pending`);
  return { ok: true, created, skipped, staleSkipped, pendingPublish };
}
