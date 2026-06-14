// scheduler 单例引用持有器。内部模板 (如 auto_plan_gen) 通过 scheduler.execute 运行时
// 拿不到 scheduler/goProc (ExecHelpers 不暴露), 但 P3 自动激活需要 activatePlan(planId, scheduler)。
// index.ts 构造 scheduler 后 setScheduler 注册, 内部模板按需 getScheduler 取用。

import type { WorkflowScheduler } from './workflow-scheduler';

let _scheduler: WorkflowScheduler | null = null;

export function setScheduler(s: WorkflowScheduler): void {
  _scheduler = s;
}

export function getScheduler(): WorkflowScheduler | null {
  return _scheduler;
}
