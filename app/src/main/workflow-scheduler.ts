// 工作流调度引擎 (M7). 主进程持有, 启动时 init + 注册 setTimeout, 到点触发 execute.
// 参考 SPEC §13.3 + §13.6 + §13.9.

import { BrowserWindow, powerMonitor, net } from 'electron';
import log from 'electron-log/main';
import type { GoSubprocess } from './go-subprocess';
import { licenseManager, type LlmConfig } from './license';
import { checkRate, logRate, type RateAction } from './rate';
import {
  type Workflow, type WorkflowRun, type Schedule, type StepLogEntry, type FailReason, type RunStatus,
  listEnabledWorkflows, getWorkflow, updateWorkflow,
  insertRun, updateRun, appendRunStep,
} from './workflow-db';
import { TEMPLATES, type Template, type ExecHelpers, type ExecResult } from './workflow-templates';

// ============ helpers (注入到模板 execute) ============

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class LlmTimeoutError extends Error { constructor() { super('LLM timeout (30s)'); } }
class InsufficientQuotaError extends Error { constructor() { super('LLM quota exhausted (429)'); } }
class RateLimitError extends Error {
  constructor(public action: RateAction, public reason: string) { super(`RateLimiter abort: ${action} - ${reason}`); }
}

function classifyError(e: unknown): FailReason {
  if (e instanceof LlmTimeoutError) return 'llm_timeout';
  if (e instanceof InsufficientQuotaError) return 'quota_exhausted';
  if (e instanceof RateLimitError) return 'rate_limited';
  const msg = e instanceof Error ? e.message?.toLowerCase() : String(e).toLowerCase();
  if (msg.includes('401') || msg.includes('403')) return 'llm_auth';
  if (msg.match(/llm.*5\d\d/) || msg.match(/5\d\d.*llm/)) return 'llm_5xx';
  if (msg.includes('cookies') || msg.includes('xsec') || msg.includes('-100')) return 'xhs_reject';
  if (msg.includes('fetch') || msg.includes('econnref') || msg.includes('network')) return 'network';
  return 'unknown';
}

const SUMMARY_BY_REASON: Record<FailReason, string> = {
  llm_timeout: '❌ AI 响应超时, 已重试 1 次仍失败',
  llm_5xx: '❌ AI 服务暂时不可用, 稍后会自动重试',
  quota_exhausted: '❌ 本月 AI 额度已用尽, 请联系客服续费',
  llm_auth: '❌ AI 服务未授权 (激活码状态异常?)',
  rate_limited: '⚠️ 已达频率上限',
  xhs_reject: '❌ 小红书拒绝操作, 请检查登录状态',
  network: '❌ 网络异常',
  user_abort: '⏹ 已手动停止',
  unknown: '❌ 未知错误 (详见日志)',
};

// ============ Scheduler ============

export class WorkflowScheduler {
  private timers = new Map<number, NodeJS.Timeout>();
  private running = new Set<number>();
  private queue: number[] = [];
  private fireMutex = false;
  private goProc: GoSubprocess;
  private mainWindow: BrowserWindow | null = null;

  constructor(goProc: GoSubprocess) {
    this.goProc = goProc;
  }

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  async init(): Promise<void> {
    log.info('[workflow] scheduler init');
    const enabled = listEnabledWorkflows();
    log.info(`[workflow] loading ${enabled.length} enabled workflow(s)`);
    for (const wf of enabled) {
      this.scheduleNext(wf);
    }
    powerMonitor.on('resume', () => {
      log.info('[workflow] powerMonitor resume → recompute all');
      this.recomputeAll();
    });
  }

  shutdown(): void {
    for (const h of this.timers.values()) clearTimeout(h);
    this.timers.clear();
  }

  recomputeAll(): void {
    for (const h of this.timers.values()) clearTimeout(h);
    this.timers.clear();
    const enabled = listEnabledWorkflows();
    for (const wf of enabled) {
      wf.next_fire_at = this.computeNextFireTime(wf);
      updateWorkflow(wf.id, { next_fire_at: wf.next_fire_at });
      this.scheduleNext(wf);
    }
  }

  /** 增加 / 启用 / 调度变更后调用 (清旧 timer + 重新算 next + 重 schedule). */
  rescheduleOne(workflowId: number): void {
    const old = this.timers.get(workflowId);
    if (old) clearTimeout(old);
    this.timers.delete(workflowId);
    const wf = getWorkflow(workflowId);
    if (!wf || wf.deleted_at || !wf.enabled) return;
    wf.next_fire_at = this.computeNextFireTime(wf);
    updateWorkflow(wf.id, { next_fire_at: wf.next_fire_at });
    this.scheduleNext(wf);
  }

  /** 取消调度 (disable / 删除时). */
  cancelOne(workflowId: number): void {
    const h = this.timers.get(workflowId);
    if (h) clearTimeout(h);
    this.timers.delete(workflowId);
  }

  /** dev 模式: 把 next_fire_at 改为 now+30s 立刻测试. */
  devFireSoon(workflowId: number): void {
    this.cancelOne(workflowId);
    const wf = getWorkflow(workflowId);
    if (!wf) return;
    wf.next_fire_at = Date.now() + 30 * 1000;
    updateWorkflow(wf.id, { next_fire_at: wf.next_fire_at });
    this.scheduleNext(wf);
    log.info(`[workflow] dev-fire-soon workflow ${workflowId} → ${new Date(wf.next_fire_at).toISOString()}`);
  }

  /** 手动触发 (跳过 schedule, 立即入 queue). */
  async runNow(workflowId: number): Promise<{ runId: number | null }> {
    const wf = getWorkflow(workflowId);
    if (!wf || wf.deleted_at) return { runId: null };
    log.info(`[workflow] manual run workflow ${workflowId}`);
    void this.tryFire(workflowId);
    return { runId: null };  // runId 在 execute 内分配, push 事件会带
  }

  private scheduleNext(wf: Workflow): void {
    const now = Date.now();
    if (!wf.next_fire_at) {
      wf.next_fire_at = this.computeNextFireTime(wf);
      updateWorkflow(wf.id, { next_fire_at: wf.next_fire_at });
    }
    // manual 类型: 无调度, 不注册 timer (只接受 runNow / devFireSoon 手动触发)
    const sched = this.parseSchedule(wf);
    if (sched.type === 'manual') return;

    const delay = wf.next_fire_at - now;
    if (delay <= 0) {
      // 错过, 记 missed_run 不补跑
      log.info(`[workflow] missed workflow ${wf.id} (next was ${new Date(wf.next_fire_at).toISOString()})`);
      insertRun({
        workflow_id: wf.id,
        started_at: now,
        status: 'missed',
        summary: '⏭️ 错过调度 (软件未启动)',
      });
      if (sched.type === 'once') {
        // 一次性: 错过即结束, 停用不补跑不重排
        updateWorkflow(wf.id, { enabled: 0, last_fire_at: wf.next_fire_at });
        return;
      }
      wf.last_fire_at = wf.next_fire_at;
      wf.next_fire_at = this.computeNextFireTime(wf);
      updateWorkflow(wf.id, { last_fire_at: wf.last_fire_at, next_fire_at: wf.next_fire_at });
      this.scheduleNext(wf);
      return;
    }
    // Node setTimeout max 2^31-1 ≈ 24.8 天, 单次调度足够 (最长 weekly = 7 天)
    const handle = setTimeout(() => this.tryFire(wf.id), delay);
    this.timers.set(wf.id, handle);
    log.info(`[workflow] scheduled workflow ${wf.id} at ${new Date(wf.next_fire_at).toISOString()} (in ${Math.round(delay / 1000)}s)`);
  }

  private async tryFire(workflowId: number): Promise<void> {
    // mutex 防 IPC race (renderer 同时 enable 多个时 scheduleNext 并行)
    while (this.fireMutex) await sleep(10);
    this.fireMutex = true;
    try {
      if (this.running.size > 0) {
        if (!this.queue.includes(workflowId)) this.queue.push(workflowId);
        log.info(`[workflow] queue workflow ${workflowId} (running=${[...this.running].join(',')})`);
        return;
      }
      this.running.add(workflowId);
    } finally {
      this.fireMutex = false;
    }
    try {
      await this.execute(workflowId);
    } finally {
      this.running.delete(workflowId);
      const next = this.queue.shift();
      if (next) void this.tryFire(next);
    }
  }

  private async execute(workflowId: number): Promise<void> {
    const wf = getWorkflow(workflowId);
    if (!wf || wf.deleted_at || !wf.enabled) return;
    const startedAt = Date.now();
    const runId = insertRun({ workflow_id: workflowId, started_at: startedAt, status: 'running' });
    log.info(`[workflow] execute workflow ${workflowId} (run ${runId}, template=${wf.template_id})`);
    this.push('workflow:run-started', { runId, workflowId });

    const template: Template | undefined = TEMPLATES[wf.template_id];
    if (!template) {
      updateRun(runId, {
        status: 'failed', fail_reason: 'unknown',
        summary: `❌ 未知模板: ${wf.template_id}`,
        finished_at: Date.now(),
      });
      this.push('workflow:run-finished', { runId, workflowId, status: 'failed' });
      return;
    }

    const helpers = this.buildHelpers(runId);
    try {
      const params = JSON.parse(wf.params);
      const result: ExecResult = await template.execute(params, helpers);
      updateRun(runId, {
        status: result.status,
        fail_reason: result.fail_reason ?? null,
        summary: result.summary,
        finished_at: Date.now(),
      });
      if (result.status === 'success') {
        // 重置失败计数
        updateWorkflow(wf.id, { fail_count: 0 });
      }
      this.push('workflow:run-finished', { runId, workflowId, status: result.status });
    } catch (e) {
      const reason = classifyError(e);
      const errMsg = e instanceof Error ? e.message : String(e);
      log.error(`[workflow] run ${runId} failed: ${errMsg}`);
      updateRun(runId, {
        status: 'failed', fail_reason: reason,
        summary: SUMMARY_BY_REASON[reason],
        error: errMsg, finished_at: Date.now(),
      });
      const newFail = wf.fail_count + 1;
      const patch: Partial<Workflow> = { fail_count: newFail };
      if (newFail >= 3) {
        patch.enabled = 0;
        log.warn(`[workflow] auto-disable workflow ${workflowId} after 3 consecutive failures`);
        this.cancelOne(workflowId);
        this.push('workflow:auto-disabled', { workflowId, lastReason: reason });
      }
      updateWorkflow(wf.id, patch);
      this.push('workflow:run-finished', { runId, workflowId, status: 'failed', failReason: reason });
    }
    // 重新计算 next + 重新 schedule
    const refreshed = getWorkflow(workflowId);
    if (refreshed && refreshed.enabled && !refreshed.deleted_at) {
      const sched = this.parseSchedule(refreshed);
      if (sched.type === 'once') {
        // 一次性: 执行后自动停用, 不重排 (自主运营计划行动跑完即止)
        updateWorkflow(refreshed.id, { enabled: 0, last_fire_at: startedAt });
        this.cancelOne(refreshed.id);
      } else if (sched.type !== 'manual') {
        refreshed.last_fire_at = startedAt;
        refreshed.next_fire_at = this.computeNextFireTime(refreshed);
        updateWorkflow(refreshed.id, { last_fire_at: refreshed.last_fire_at, next_fire_at: refreshed.next_fire_at });
        this.scheduleNext(refreshed);
      }
    }

  }

  private buildHelpers(runId: number): ExecHelpers {
    return {
      callTool: async (tool, args) => {
        // RateLimiter check (publish/comment/like/favorite)
        const rateAction = this.toolToRateAction(tool);
        if (rateAction) {
          const r = checkRate(rateAction);
          if (!r.allowed) throw new RateLimitError(rateAction, r.reason ?? 'rate limited');
        }
        const path = this.toolToPath(tool);
        const method = this.toolToMethod(tool);
        const body = method === 'GET' || method === 'HEAD' ? undefined : args;
        const query = method === 'GET' && args ? '?' + new URLSearchParams(args as Record<string, string>).toString() : '';
        const result = await this.goProc.callApi(method, `${path}${query}`, body);
        if (rateAction) logRate(rateAction);
        return result;
      },
      callLLM: async ({ system, user, max_tokens = 80 }) => {
        const llm = await licenseManager.getActiveLlm();
        if (!llm) throw new Error('LLM not configured (license inactive or BYOK empty)');
        return await callLLMWithRetry(llm, system, user, max_tokens);
      },
      sleep,
      rand,
      log: (entry) => {
        const step: StepLogEntry = {
          step: entry.step ?? 'log',
          at: Date.now(),
          ...(entry.result !== undefined ? { result: entry.result } : {}),
          ...(entry.error ? { error: entry.error } : {}),
        };
        appendRunStep(runId, step);
        this.push('workflow:run-step-update', { runId, step });
      },
    };
  }

  computeNextFireTime(wf: Workflow): number {
    const s = this.parseSchedule(wf);
    const base = computeBaseFireTime(s);
    // once: 一次性精确时刻, 不加抖动. 抖动会把接近当前的时刻推到过去 → scheduleNext 误判 missed → 行动静默不执行.
    if (s.type === 'once') return base;
    const jitterMin = s.jitter_min ?? 10;
    const jitterMs = jitterMin * 60 * 1000;
    const jitter = (Math.random() * 2 - 1) * jitterMs;
    return base + jitter;
  }

  private parseSchedule(wf: Workflow): Schedule {
    return JSON.parse(wf.schedule) as Schedule;
  }

  private toolToRateAction(tool: string): RateAction | null {
    if (tool === 'like_feed') return 'like';
    if (tool === 'favorite_feed') return 'favorite';
    if (tool === 'post_comment_to_feed' || tool === 'reply_comment_in_feed') return 'comment';
    if (tool === 'publish_content' || tool === 'publish_with_video') return 'publish';
    return null;
  }

  private toolToPath(tool: string): string {
    // 对照 xiaohongshu-mcp/routes.go (api/v1 路由组)
    const map: Record<string, string> = {
      check_login_status:     '/api/v1/login/status',
      list_feeds:             '/api/v1/feeds/list',
      search_feeds:           '/api/v1/feeds/search',
      get_feed_detail:        '/api/v1/feeds/detail',
      user_profile:           '/api/v1/user/profile',     // 单数 user, 实际 POST
      my_profile:             '/api/v1/user/me',           // 单数 user, GET
      like_feed:              '/api/v1/feeds/like',
      favorite_feed:          '/api/v1/feeds/favorite',
      post_comment_to_feed:   '/api/v1/feeds/comment',
      reply_comment_in_feed:  '/api/v1/feeds/comment/reply',
      publish_content:        '/api/v1/publish',
      publish_with_video:     '/api/v1/publish_video',
    };
    return map[tool] || `/api/v1/${tool}`;
  }

  private toolToMethod(tool: string): string {
    // 对照 xiaohongshu-mcp/routes.go: 只读类 GET, 其余 POST (含 user_profile/feed_detail 是 POST 因带 body)
    if (
      tool === 'check_login_status' ||
      tool === 'list_feeds' ||
      tool === 'my_profile'
    ) return 'GET';
    return 'POST';
  }

  private push(channel: string, payload: unknown): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send(channel, payload);
  }
}

// ============ LLM 单次 completion (timeout + retry) ============

async function callLLMWithRetry(llm: LlmConfig, system: string, user: string, maxTokens: number): Promise<string> {
  const MAX_RETRY = 1;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      return await callLLMOnce(llm, system, user, maxTokens);
    } catch (e) {
      lastErr = e as Error;
      const msg = lastErr.message.toLowerCase();
      // 429 / 401 / 403 不 retry, 直接抛
      if (msg.includes('429')) throw new InsufficientQuotaError();
      if (msg.includes('401') || msg.includes('403')) throw lastErr;
      if (attempt < MAX_RETRY) {
        const backoff = 2000 * Math.pow(2, attempt);
        log.warn(`[workflow] LLM retry ${attempt + 1}/${MAX_RETRY} in ${backoff}ms: ${msg}`);
        await sleep(backoff);
      }
    }
  }
  throw lastErr!;
}

async function callLLMOnce(llm: LlmConfig, system: string, user: string, maxTokens: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30 * 1000);
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
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`LLM ${resp.status}: ${text.slice(0, 200)}`);
    }
    const json = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content?.trim() ?? '';
    if (!content) throw new Error('LLM returned empty content');
    return content;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new LlmTimeoutError();
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// ============ schedule 计算 ============

function computeBaseFireTime(s: Schedule): number {
  // 按 wf.schedule.tz (创建时锁定) 算 base. P1 简化: 用本地 tz (Intl 默认), 不实际跨 tz 转换.
  // 跨时区出差场景属 P2 优化点 (SPEC §13.2 注明).
  const now = new Date();
  switch (s.type) {
    case 'daily': {
      const next = new Date();
      next.setHours(s.hour ?? 9, s.minute ?? 0, 0, 0);
      if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
      return next.getTime();
    }
    case 'weekly': {
      const next = new Date();
      next.setHours(s.hour ?? 9, s.minute ?? 0, 0, 0);
      const targetDow = s.weekday ?? 1;
      const diff = (targetDow - next.getDay() + 7) % 7 || (next.getTime() <= now.getTime() ? 7 : 0);
      next.setDate(next.getDate() + diff);
      return next.getTime();
    }
    case 'interval': {
      const hours = s.interval_hours ?? 6;
      return now.getTime() + hours * 60 * 60 * 1000;
    }
    case 'once':
      // 一次性: 在指定绝对时间执行 (自主运营计划行动). 执行/错过后停用, 不重排.
      return s.at ?? now.getTime();
    case 'manual':
    default:
      return now.getTime() + 365 * 24 * 60 * 60 * 1000;  // 远期, 不会触发 (scheduleNext 内已 short-circuit)
  }
}

// Re-export types for IPC
export type { Workflow, WorkflowRun, Schedule, RunStatus, FailReason } from './workflow-db';
