// 计划实例化 (M3). 把运营计划的行动项落成可调度的工作流, 接入现有 WorkflowScheduler.
//   - interact (点赞评论) → keyword_like_comment 工作流 + once 一次性调度 (到点自动执行)
//   - browse (纯浏览养号) → 暂跳过 (现有无纯浏览模板, P2 补)
//   - publish (发布) → 暂跳过, 保持 pending (留 M4 待审闸门处理)
// 设计见 AIREADME/DESIGN-autonomous-operation.md §6/§7.

import log from 'electron-log/main';
import type { WorkflowScheduler } from './workflow-scheduler';
import { createWorkflow, softDeleteWorkflow } from './workflow-db';
import { getPlan, listActions, updateActionStatus, setPlanStatus, listPlansByStatus } from './operating-db';

interface InteractSpec {
  keyword?: string;
  like?: number;
  comment?: number;
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
  created: number;   // 实例化的互动工作流数
  skipped: number;   // 跳过的行动数 (browse + publish)
  pendingPublish: number; // 留待审核的发布数
  error?: string;
}

export function activatePlan(planId: number, scheduler: WorkflowScheduler): ActivatePlanResult {
  const plan = getPlan(planId);
  if (!plan) return { ok: false, created: 0, skipped: 0, pendingPublish: 0, error: '计划不存在' };
  // 幂等: 已激活的计划不重复实例化 (防连点 / 重复 IPC)
  if (plan.status === 'active') {
    return { ok: false, created: 0, skipped: 0, pendingPublish: 0, error: '此计划已激活, 如需重排请重新生成计划' };
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
  let created = 0;
  let skipped = 0;
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
      // top_n 取 like/comment 的较大值, 落在 [1,5] (模板硬上限 5 防风控)
      const topN = Math.min(Math.max(spec.like ?? 0, spec.comment ?? 0, 1), 5);
      const wf = createWorkflow({
        template_id: 'keyword_like_comment',
        name: `[运营] 互动「${keyword}」`,
        params: { keyword, sort: 'general', top_n: topN, comment_style: 'praise' },
        schedule: { type: 'once', at: a.scheduled_at, jitter_min: 5, tz },
        enabled: true,
      });
      scheduler.rescheduleOne(wf.id);
      updateActionStatus(a.id, 'scheduled', wf.id);
      created++;
    } else if (a.type === 'browse') {
      // 纯浏览养号: 现有无对应模板, P2 补「定时浏览」后再实例化
      updateActionStatus(a.id, 'skipped');
      skipped++;
    } else if (a.type === 'publish') {
      // 发布: 实例化成 planned_publish 工作流 (once 调度), 到点拟稿进待审队列, 用户确认才发
      let spec: PublishSpec = {};
      try {
        spec = JSON.parse(a.spec) as PublishSpec;
      } catch {
        /* ignore */
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
        schedule: { type: 'once', at: a.scheduled_at, jitter_min: 5, tz },
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
  log.info(`[plan-instantiate] plan ${planId} activated: ${created} interact workflows, ${skipped} skipped, ${pendingPublish} publish pending`);
  return { ok: true, created, skipped, pendingPublish };
}
