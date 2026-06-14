// P3 全自动模式配置中枢 (ADR-017「审核窗口自动发」veto-window)。
// 总开关默认关; 开启后: ① 新拟稿带 auto_publish_at=now+窗口 (窗口内未否决则过护栏自动发)
// ② auto_plan_gen 生成的计划自动激活。一键关 = 关开关, scheduler 扫描即 no-op。
// 配置存 workflow-db 的 KV config 表 (与 workflow_risk_accepted 同处)。

import { getConfig, setConfig } from './workflow-db';

const KEY_ENABLED = 'auto_pilot_enabled';
const KEY_WINDOW_HOURS = 'auto_publish_window_hours';
const DEFAULT_WINDOW_HOURS = 6;
const MIN_WINDOW_HOURS = 1;
const MAX_WINDOW_HOURS = 72;

export function isAutoPilotEnabled(): boolean {
  return getConfig(KEY_ENABLED) === '1';
}

export function setAutoPilotEnabled(on: boolean): void {
  setConfig(KEY_ENABLED, on ? '1' : '0');
}

export function autoPublishWindowHours(): number {
  const h = Number(getConfig(KEY_WINDOW_HOURS));
  if (!Number.isFinite(h) || h <= 0) return DEFAULT_WINDOW_HOURS;
  return Math.min(Math.max(Math.round(h), MIN_WINDOW_HOURS), MAX_WINDOW_HOURS);
}

export function setAutoPublishWindowHours(h: number): void {
  const clamped = Math.min(Math.max(Math.round(Number(h) || DEFAULT_WINDOW_HOURS), MIN_WINDOW_HOURS), MAX_WINDOW_HOURS);
  setConfig(KEY_WINDOW_HOURS, String(clamped));
}

export function autoPublishWindowMs(): number {
  return autoPublishWindowHours() * 60 * 60 * 1000;
}
