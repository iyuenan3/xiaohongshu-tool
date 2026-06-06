// auto_plan_gen 模板 (P2/E1): 每周自动据画像 + 反馈数据生成下一期运营计划进待审 (draft).
// 只生成不激活 (人在环): 用户在「自主运营」看到新计划 → 审核/编辑 → 激活才执行。
// 内部模板 (不在"新建工作流"列表), 由自主运营页"每周自动生成"开关管理。

import { Notification } from 'electron';
import { generatePlan } from '../planner';
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
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: 'xhsPilot · 新计划待审',
          body: `已生成 ${r.actionsCount} 个行动的计划，去「自主运营」审核激活`,
        }).show();
      }
    } catch {
      /* 通知失败不影响生成 */
    }
    return { status: 'success', summary: `🗓 已生成 ${r.actionsCount} 个行动的计划进待审 — 去「自主运营」审核激活` };
  },
};
