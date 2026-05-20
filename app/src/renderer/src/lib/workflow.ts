// Renderer 侧工作流 helper (M7).

import type { ScheduleP, WorkflowP, WorkflowRunP, TemplateMetaP } from '../../../preload/index';

export type { ScheduleP, WorkflowP, WorkflowRunP, TemplateMetaP };

export function formatSchedule(scheduleStr: string): string {
  try {
    const s = JSON.parse(scheduleStr) as ScheduleP;
    const hh = String(s.hour ?? 0).padStart(2, '0');
    const mm = String(s.minute ?? 0).padStart(2, '0');
    const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
    switch (s.type) {
      case 'daily': return `每天 ${hh}:${mm}`;
      case 'weekly': return `每周${WEEKDAYS[s.weekday ?? 1]} ${hh}:${mm}`;
      case 'interval': return `每 ${s.interval_hours ?? 6} 小时`;
      case 'manual': return '手动触发';
      default: return scheduleStr;
    }
  } catch {
    return scheduleStr;
  }
}

export function formatNextFire(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${m}-${day} ${h}:${min}`;
}

export function statusPill(wf: WorkflowP): { text: string; tone: 'ok' | 'warn' | 'err' | 'mute' } {
  if (wf.deleted_at) return { text: '已删除', tone: 'mute' };
  if (!wf.enabled) {
    if (wf.fail_count >= 3) return { text: '🚫 失败禁用', tone: 'err' };
    return { text: '⏸ 暂停', tone: 'mute' };
  }
  if (wf.fail_count > 0) return { text: `⚠️ 失败 ${wf.fail_count}/3`, tone: 'warn' };
  return { text: '✅ 启用', tone: 'ok' };
}

export function runStatusLabel(run: WorkflowRunP): { text: string; tone: 'ok' | 'warn' | 'err' | 'mute' } {
  switch (run.status) {
    case 'running': return { text: '🔄 运行中', tone: 'warn' };
    case 'success': return { text: '✅ 成功', tone: 'ok' };
    case 'partial': return { text: '⚠️ 部分完成', tone: 'warn' };
    case 'failed': return { text: '❌ 失败', tone: 'err' };
    case 'missed': return { text: '⏭️ 错过', tone: 'mute' };
    case 'aborted': return { text: '⏹ 已停止', tone: 'mute' };
    case 'disabled_by_failure': return { text: '🚫 失败禁用', tone: 'err' };
    default: return { text: run.status, tone: 'mute' };
  }
}

export function getLocalTz(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'; }
  catch { return 'Asia/Shanghai'; }
}

export const WEEKDAY_OPTIONS = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' },
];
