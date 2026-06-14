// auto_plan_gen 模板 (P2/E1): 每周自动据画像 + 反馈数据生成下一期运营计划进待审 (draft).
// 只生成不激活 (人在环): 用户在「自主运营」看到新计划 → 审核/编辑 → 激活才执行。
// 内部模板 (不在"新建工作流"列表), 由自主运营页"每周自动生成"开关管理。

import { Notification } from 'electron';
import { generatePlan } from '../planner';
import { isAutoPilotEnabled } from '../auto-pilot';
import { getScheduler } from '../scheduler-ref';
import { activatePlan } from '../plan-instantiate';
import { listPlansByStatus } from '../operating-db';
import type { Template, ExecHelpers, ExecResult } from './index';

export const autoPlanGen: Template = {
  id: 'auto_plan_gen',
  name: '每周自动生成计划',
  emoji: '🗓',
  description: '每周自动据画像 + 反馈数据生成下一期计划进待审 (不自动激活, 用户审核后才执行).',
  paramsSchema: {
    horizon_days: { type: 'int', min: 3, max: 14, default: 7, label: '计划周期 (天)' },
  },
  async execute(params: Record<string, unknown>, helpers: ExecHelpers): Promise<ExecResult> {
    const horizon = Math.min(Math.max(Number(params.horizon_days ?? 7), 3), 14);
    helpers.log({ step: 'start', result: { horizon } });
    const r = await generatePlan(horizon);
    if (!r.ok) {
      helpers.log({ step: 'generate', error: r.error });
      return { status: 'partial', summary: `🗓 自动生成计划失败: ${r.error}` };
    }
    helpers.log({ step: 'generate', result: { planId: r.planId, actions: r.actionsCount } });

    // P3 全自动: 开关开时自动激活刚生成的计划 (互动/浏览自动跑; 发布仍走 veto-window 待审自动发)。
    // 关时维持 P2 行为: 只生成进待审, 用户审核后才激活。
    let activated = false;
    let skippedActive = false; // 已有在跑计划, 未自动覆盖 (留待审)
    if (isAutoPilotEnabled()) {
      const scheduler = getScheduler();
      if (!scheduler) {
        helpers.log({ step: 'auto_activate', error: 'scheduler 未就绪, 跳过自动激活' });
      } else if (listPlansByStatus('active').length > 0) {
        // 已有 active 计划 (尤其用户手动激活的在跑): 不自动激活覆盖, 留新计划作 draft 待审, 由用户决定是否切换
        skippedActive = true;
        helpers.log({ step: 'auto_activate', result: { skipped: 'has-active-plan' } });
      } else {
        const act = activatePlan(r.planId, scheduler);
        activated = act.ok;
        helpers.log({ step: 'auto_activate', result: { ok: act.ok, created: act.created, pendingPublish: act.pendingPublish, error: act.error } });
      }
    }

    const body = activated
      ? `已生成并激活 ${r.actionsCount} 个行动 (全自动模式)，发布将在审核窗口内自动发`
      : skippedActive
        ? `已生成 ${r.actionsCount} 个行动的计划进待审 (已有计划在跑, 未自动覆盖)，去「自主运营」决定是否切换`
        : `已生成 ${r.actionsCount} 个行动的计划，去「自主运营」审核激活`;
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: activated ? 'xhsPilot · 新计划已自动激活' : 'xhsPilot · 新计划待审',
          body,
        }).show();
      }
    } catch {
      /* 通知失败不影响生成 */
    }
    return {
      status: 'success',
      summary: activated
        ? `🗓 已生成并自动激活 ${r.actionsCount} 个行动 (全自动模式)`
        : skippedActive
          ? `🗓 已生成 ${r.actionsCount} 个行动进待审 (已有计划在跑, 未覆盖) — 去「自主运营」决定切换`
          : `🗓 已生成 ${r.actionsCount} 个行动的计划进待审 — 去「自主运营」审核激活`,
    };
  },
};
