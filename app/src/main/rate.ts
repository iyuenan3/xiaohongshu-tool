// 频率护栏. 软提示, 用户可绕过, 不硬拦截 (见 PRD/SPEC §3.8).

import { getDb } from './db';

export type RateAction = 'publish' | 'comment' | 'like' | 'favorite';

interface GuardConfig {
  /** 时间窗口 (ms) 内允许的最大次数 */
  max: number;
  windowMs: number;
  /** 最小间隔 (ms), 0 表示无间隔要求 */
  gapMs?: number;
}

const GUARDS: Record<RateAction, GuardConfig> = {
  publish:  { max: 3,  windowMs: 24 * 60 * 60 * 1000, gapMs: 30 * 60 * 1000 },
  comment:  { max: 10, windowMs: 60 * 60 * 1000 },
  like:     { max: 30, windowMs: 60 * 60 * 1000 },
  favorite: { max: 30, windowMs: 60 * 60 * 1000 },
};

export interface RateCheckResult {
  allowed: boolean;
  reason?: string;
  windowCount?: number;
  windowMax?: number;
  nextAvailableAt?: number;
}

export function checkRate(action: RateAction): RateCheckResult {
  const cfg = GUARDS[action];
  if (!cfg) return { allowed: true };
  const now = Date.now();
  const since = now - cfg.windowMs;

  // 1. 窗口次数
  const cnt = getDb()
    .prepare(`SELECT COUNT(*) as c FROM rate_log WHERE action = ? AND created_at > ?`)
    .get(action, since) as { c: number };

  if (cnt.c >= cfg.max) {
    return {
      allowed: false,
      reason: `已达频率上限 (${cnt.c}/${cfg.max}, 窗口 ${humanWindow(cfg.windowMs)})`,
      windowCount: cnt.c,
      windowMax: cfg.max,
    };
  }

  // 2. 最小间隔
  if (cfg.gapMs && cfg.gapMs > 0) {
    const last = getDb()
      .prepare(`SELECT created_at FROM rate_log WHERE action = ? ORDER BY created_at DESC LIMIT 1`)
      .get(action) as { created_at: number } | undefined;
    if (last && now - last.created_at < cfg.gapMs) {
      const wait = cfg.gapMs - (now - last.created_at);
      return {
        allowed: false,
        reason: `距上次 ${action} 不足 ${humanMs(cfg.gapMs)}, 还需等 ${humanMs(wait)}`,
        nextAvailableAt: last.created_at + cfg.gapMs,
      };
    }
  }

  return {
    allowed: true,
    windowCount: cnt.c,
    windowMax: cfg.max,
  };
}

export function logRate(action: RateAction): void {
  getDb().prepare(`INSERT INTO rate_log (action, created_at) VALUES (?, ?)`).run(action, Date.now());
}

function humanWindow(ms: number): string {
  if (ms >= 24 * 3600_000) return `${Math.round(ms / 3600_000 / 24)} 天`;
  if (ms >= 3600_000) return `${Math.round(ms / 3600_000)} 小时`;
  return `${Math.round(ms / 60_000)} 分钟`;
}
function humanMs(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} 分钟`;
  return `${Math.round(ms / 1000)} 秒`;
}
