// 工作流调度引擎 (M7). 主进程持有, 启动时 init + 注册 setTimeout, 到点触发 execute.
// 参考 SPEC §13.3 + §13.6 + §13.9.

import { BrowserWindow, powerMonitor, net, Notification } from 'electron';
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
import { isAutoPilotEnabled } from './auto-pilot';
import { listDueAutoPublish, clearAutoPublishAt, bumpAutoPublishAttempts, recoverStuckPublishing, completeActionAndMaybePlan } from './operating-db';
import { approvePublish, type ApproveResult } from './publish-gate';

// P3 全自动: 每隔此间隔扫一次到点该自动发的待审 (window 默认 6h, 5min 粒度足够; 重启后首扫即补发过期窗口的)
const AUTO_PUBLISH_SWEEP_MS = 5 * 60 * 1000;
// 自动发真发 API 连续失败上限, 达到转人工 (防登录态长期失效时每 5min 永久死磕)
const MAX_AUTO_PUBLISH_ATTEMPTS = 3;

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
  private runAborts = new Map<number, AbortController>(); // workflowId → 运行中 run 的 AbortController (手动停止用)
  private fireMutex = false;
  private goProc: GoSubprocess;
  private mainWindow: BrowserWindow | null = null;
  private autoPublishTimer: NodeJS.Timeout | null = null; // P3 全自动发布扫描定时器
  private autoPublishSweeping = false; // 防扫描重入

  constructor(goProc: GoSubprocess) {
    this.goProc = goProc;
  }

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  async init(): Promise<void> {
    log.info('[workflow] scheduler init');
    // P3: 恢复上次崩溃留下的卡死 publishing 行 (转人工, 结果未知不自动重发)
    const recovered = recoverStuckPublishing();
    if (recovered) log.warn(`[workflow] recovered ${recovered} stuck 'publishing' pending → manual`);
    const enabled = listEnabledWorkflows();
    log.info(`[workflow] loading ${enabled.length} enabled workflow(s)`);
    for (const wf of enabled) {
      this.scheduleNext(wf);
    }
    powerMonitor.on('resume', () => {
      log.info('[workflow] powerMonitor resume → recompute all');
      this.recomputeAll();
    });
    this.startAutoPublishSweep();
  }

  shutdown(): void {
    for (const h of this.timers.values()) clearTimeout(h);
    this.timers.clear();
    if (this.autoPublishTimer) { clearInterval(this.autoPublishTimer); this.autoPublishTimer = null; }
  }

  // P3 全自动「审核窗口自动发」: 周期扫到点待审, 过 approvePublish 全护栏 (禁忌/频率/素材) 才真发。
  // 总开关关时整扫 no-op (= 一键停)。基于 DB 状态扫描而非定时器, 故重启/休眠后首扫即补发过期窗口的。
  private startAutoPublishSweep(): void {
    if (this.autoPublishTimer) return;
    this.autoPublishTimer = setInterval(() => { void this.runAutoPublishDue(); }, AUTO_PUBLISH_SWEEP_MS);
    // 启动后稍等 Go/登录态就绪再首扫 (approvePublish 需 Go + 登录)
    setTimeout(() => { void this.runAutoPublishDue(); }, 30 * 1000);
  }

  private async runAutoPublishDue(): Promise<void> {
    if (this.autoPublishSweeping) return;
    if (!isAutoPilotEnabled()) return; // 一键停: 开关关即 no-op
    const due = listDueAutoPublish(Date.now());
    if (!due.length) return;
    // Go 未就绪 (重启/未起) → 整扫跳过, 下次再试, 不动 auto_publish_at (避免把待发的误转人工)
    let healthy = false;
    try { healthy = await this.goProc.health(); } catch { healthy = false; }
    if (!healthy) { log.info('[workflow] auto-publish sweep skipped: Go not ready'); return; }

    this.autoPublishSweeping = true;
    try {
      for (const p of due) {
        if (!isAutoPilotEnabled()) break; // 扫描途中被关 → 立即停
        const title = p.title ?? '(无标题)';
        let r: ApproveResult;
        try {
          r = await approvePublish(p.id, this.goProc);
        } catch (e) {
          // approvePublish 内部已 catch 真发错误; 走到这是意外异常, 按可重试失败处理 (有界)
          r = { ok: false, error: `发布失败: ${String(e)}`, reason: 'publish_failed' };
        }
        if (r.ok) {
          log.info(`[workflow] auto-published pending ${p.id} 「${title}」`);
          this.notify('xhsPilot · 已自动发布', `「${title}」已按全自动模式发布到小红书`);
          this.push('operating:pending-changed', {});
          continue;
        }
        switch (r.reason) {
          case 'rate':
            // 频率/间隔未到点 → 顺延, 下次扫描重试 (不计失败、不通知、不转人工)
            log.info(`[workflow] auto-publish ${p.id} deferred (rate): ${r.error}`);
            break;
          case 'claimed':
          case 'gone':
            // 已被并发的手动确认/拒绝/扫描处理掉 → 跳过, 不动
            log.info(`[workflow] auto-publish ${p.id} skipped (${r.reason})`);
            break;
          case 'timeout':
            // 结果未知 (可能已发出) → 绝不自动重试 (防重复发到唯一账号), 转人工 + 提醒核对
            clearAutoPublishAt(p.id);
            log.warn(`[workflow] auto-publish ${p.id} timeout, → manual (result unknown)`);
            this.notify('xhsPilot · 自动发布结果未知', `「${title}」发布超时, 可能已发出。已转人工, 请去小红书核对避免重复发布`);
            this.push('operating:pending-changed', {});
            break;
          case 'publish_failed': {
            // 明确失败 (HTTP 错/Go 拒/网络) → 有界重试; 连续达上限转人工 (防永久死磕 + 告知根因)
            const attempts = bumpAutoPublishAttempts(p.id);
            if (attempts >= MAX_AUTO_PUBLISH_ATTEMPTS) {
              clearAutoPublishAt(p.id);
              log.warn(`[workflow] auto-publish ${p.id} failed ${attempts}x → manual: ${r.error}`);
              this.notify('xhsPilot · 自动发布多次失败', `「${title}」连续 ${attempts} 次发布失败 (多为登录态失效/网络), 已转人工待审, 请检查后手动确认`);
              this.push('operating:pending-changed', {});
            } else {
              log.warn(`[workflow] auto-publish ${p.id} fail ${attempts}/${MAX_AUTO_PUBLISH_ATTEMPTS}, retry next: ${r.error}`);
            }
            break;
          }
          default:
            // guardrail (禁忌词/无配图/标题空) → 转人工, 需用户编辑, 不再自动重试
            clearAutoPublishAt(p.id);
            log.warn(`[workflow] auto-publish ${p.id} blocked → manual: ${r.error}`);
            this.notify('xhsPilot · 自动发布未通过', `「${title}」${r.error ?? '未通过护栏'}，已转人工待审`);
            this.push('operating:pending-changed', {});
        }
      }
    } finally {
      this.autoPublishSweeping = false;
    }
  }

  recomputeAll(): void {
    for (const h of this.timers.values()) clearTimeout(h);
    this.timers.clear();
    const enabled = listEnabledWorkflows();
    for (const wf of enabled) {
      // 跳过正在执行的工作流: 其生命周期 (next 重算/重排) 由 execute 末尾独占管理。
      // 否则 resume 落在某 once 执行中会把它误判 missed + 提前 enabled=0 (假 missed 记录); 对 daily/interval 则留下孤儿 timer 致重复跑。
      if (this.running.has(wf.id)) continue;
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
    // 防孤儿 timer: 注册前清掉该 wf 已有的 timer (recomputeAll 与 execute-finally 双路径可能各注册一个)
    const stale = this.timers.get(wf.id);
    if (stale) { clearTimeout(stale); this.timers.delete(wf.id); }
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
        this.markPlanActionSkipped(wf); // 错过的计划行动标 skipped, 防计划永久 active 顶死 P3 自动激活
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
      // 已在执行的同一工作流不再排队/重入 (防孤儿 timer / runNow 在执行中再触发 → 同 once 行动重复跑)
      if (this.running.has(workflowId)) {
        log.info(`[workflow] skip workflow ${workflowId}: already running`);
        return;
      }
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

    const ac = new AbortController();
    this.runAborts.set(workflowId, ac);
    const helpers = this.buildHelpers(runId, ac.signal);
    try {
      const params = JSON.parse(wf.params);
      const result: ExecResult = await template.execute(params, helpers);
      if (ac.signal.aborted) {
        // 模板把 abort 当 skip 吞了仍正常返回 → 强制改判已停止
        this.markAborted(runId, workflowId);
      } else {
        updateRun(runId, {
          status: result.status,
          fail_reason: result.fail_reason ?? null,
          summary: result.summary,
          finished_at: Date.now(),
        });
        if (result.status === 'success') {
          updateWorkflow(wf.id, { fail_count: 0 }); // 重置失败计数
        }
        this.push('workflow:run-finished', { runId, workflowId, status: result.status });
        // 计划/行动 done 回写: 互动/浏览类 once 行动跑完 (success/partial 都算已执行) → 标 plan_action='done' + 计划完结判定。
        // 发布类 (planned_publish) 例外: 它只是拟稿, 行动 done 由 approve/reject 回写 (见 publish-gate)。
        if (wf.template_id !== 'planned_publish' && typeof params.plan_action_id === 'number' && params.plan_action_id > 0) {
          try { completeActionAndMaybePlan(params.plan_action_id); } catch (err) { log.warn(`[workflow] completeAction failed: ${String(err)}`); }
        }
      }
    } catch (e) {
      if (ac.signal.aborted) {
        // 手动停止 (sleep/callTool 抛 abort 冒泡到这): 不算失败、不计 fail_count、不自动停用
        this.markAborted(runId, workflowId);
        this.markPlanActionSkipped(wf); // once 行动被手动停 = 终态, 标 skipped 防计划永久 active
      } else {
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
        this.notify('xhsPilot · 工作流失败', `「${wf.name}」${SUMMARY_BY_REASON[reason]}`);
        if (newFail >= 3) {
          patch.enabled = 0;
          log.warn(`[workflow] auto-disable workflow ${workflowId} after 3 consecutive failures`);
          this.cancelOne(workflowId);
          this.notify('xhsPilot · 工作流已停用', `「${wf.name}」连续失败 3 次, 已自动停用`);
          this.push('workflow:auto-disabled', { workflowId, lastReason: reason });
        }
        updateWorkflow(wf.id, patch);
        this.push('workflow:run-finished', { runId, workflowId, status: 'failed', failReason: reason });
        this.markPlanActionSkipped(wf); // once 行动执行失败 = 终态 (once 不重试), 标 skipped 防计划永久 active
      }
    } finally {
      this.runAborts.delete(workflowId);
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

  private markAborted(runId: number, workflowId: number): void {
    log.info(`[workflow] run ${runId} (workflow ${workflowId}) aborted by user`);
    updateRun(runId, {
      status: 'aborted', fail_reason: 'user_abort',
      summary: SUMMARY_BY_REASON.user_abort, finished_at: Date.now(),
    });
    this.push('workflow:run-finished', { runId, workflowId, status: 'aborted' });
  }

  // 计划行动的 once 工作流走到非成功终态 (missed/failed/aborted) → 标 plan_action='skipped' + 计划完结判定。
  // 漏了它会让 action 永久卡 'scheduled' → plan 永久 active → P3 每周自动激活闸门被陈旧 active 顶死。
  // 含 planned_publish: 它若 missed/failed/aborted 则没产出待审稿, 该发布行动也不会再 approve/reject, 应标终态。
  private markPlanActionSkipped(wf: Workflow): void {
    try {
      const p = JSON.parse(wf.params) as { plan_action_id?: number };
      if (typeof p.plan_action_id === 'number' && p.plan_action_id > 0) {
        completeActionAndMaybePlan(p.plan_action_id, 'skipped');
      }
    } catch (err) {
      log.warn(`[workflow] markPlanActionSkipped failed: ${String(err)}`);
    }
  }

  /** 手动停止: 运行中→abort 在途请求+sleep; 排队中→移出队列. 返回命中状态. */
  abortRun(workflowId: number): { ok: boolean; state: 'running' | 'queued' | 'none' } {
    const ac = this.runAborts.get(workflowId);
    if (ac) {
      ac.abort();
      log.info(`[workflow] abort requested for running workflow ${workflowId}`);
      return { ok: true, state: 'running' };
    }
    const qi = this.queue.indexOf(workflowId);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      log.info(`[workflow] removed queued workflow ${workflowId}`);
      return { ok: true, state: 'queued' };
    }
    return { ok: false, state: 'none' };
  }

  private notify(title: string, body: string): void {
    try {
      if (Notification.isSupported()) new Notification({ title, body }).show();
    } catch (e) {
      log.warn(`[workflow] notify failed: ${String(e)}`);
    }
  }

  private buildHelpers(runId: number, signal: AbortSignal): ExecHelpers {
    return {
      callTool: async (tool, args) => {
        if (signal.aborted) throw new Error('已手动停止');
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
        const result = await this.goProc.callApi(method, `${path}${query}`, body, signal);
        if (rateAction) logRate(rateAction);
        return result;
      },
      callLLM: async ({ system, user, max_tokens = 80 }) => {
        if (signal.aborted) throw new Error('已手动停止');
        const llm = await licenseManager.getActiveLlm();
        if (!llm) throw new Error('LLM not configured (license inactive or BYOK empty)');
        return await callLLMWithRetry(llm, system, user, max_tokens, signal); // signal: 停止时掐断 LLM, 避免评论生成时停止要等 ~60s
      },
      // 可中断 sleep: 手动停止时立即 reject。模板循环里 callTool/callLLM 调用前已检查 signal 抛错、
      // execute 会在模板返回后复查 ac.signal.aborted 改判 aborted; sleep reject 主要让"停留等待中"的取消即时生效。
      sleep: (ms: number) =>
        new Promise<void>((resolve, reject) => {
          if (signal.aborted) return reject(new Error('已手动停止'));
          const t = setTimeout(resolve, ms);
          signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('已手动停止')); }, { once: true });
        }),
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
    const jittered = base + jitter;
    // 负向抖动可能把临近的 base (如激活当晚 23:30 的采集器, 此刻已 23:2x) 推到过去 → scheduleNext 误判 missed 跳一次。
    // 抖到过去则回退到不抖的 base (base 由 computeBaseFireTime 保证未来), 保证首次也能正常排。
    return jittered > Date.now() ? jittered : base;
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

async function callLLMWithRetry(llm: LlmConfig, system: string, user: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
  const MAX_RETRY = 1;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (signal?.aborted) throw new Error('已手动停止');
    try {
      return await callLLMOnce(llm, system, user, maxTokens, signal);
    } catch (e) {
      lastErr = e as Error;
      const msg = lastErr.message.toLowerCase();
      if (signal?.aborted) throw lastErr; // 手动停止: 不 retry
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

async function callLLMOnce(llm: LlmConfig, system: string, user: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30 * 1000);
  const onExt = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExt, { once: true });
  }
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
    if (signal?.aborted) throw new Error('已手动停止');
    if (e instanceof Error && e.name === 'AbortError') throw new LlmTimeoutError();
    throw e;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onExt);
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
