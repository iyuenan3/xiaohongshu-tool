// 全局运行状态条 (底栏). 订阅工作流运行事件, 任何 tab 都能看到「正在执行哪个工作流 + 当前到哪一步」.
// 自主运营的互动/浏览/发布拟稿任务都走 WorkflowScheduler, 因此都会在这里实时显示进度.
import { useEffect, useRef, useState } from 'react';

// 底栏展示「实时执行」过程, status 取 onRunFinished 会推的: success / partial / failed / aborted(手动停止)。
// (missed 发生在调度阶段无 run-started, auto-disabled 走独立 channel, 均归 run history 展示)。
interface RunState {
  runId: number;
  workflowId: number;
  name: string;
  step: string;
  status: 'running' | 'success' | 'partial' | 'failed' | 'aborted';
  stopping?: boolean;
}

// 模板内 helpers.log({ step }) 用的 step key → 友好中文
const STEP_LABELS: Record<string, string> = {
  start: '开始',
  list_feeds: '拉取首页笔记',
  search_feeds: '搜索笔记',
  fetch_feeds: '拉取笔记',
  view_feed: '浏览笔记',
  like_feed: '点赞',
  gen_comment: '生成评论',
  post_comment: '发表评论',
  publish: '发布',
  snapshot: '采集数据',
};

const STATUS_TEXT: Record<string, string> = {
  success: '✓ 完成',
  partial: '⚠ 部分完成',
  failed: '✕ 失败',
  aborted: '⏹ 已停止',
};

export default function RunStatusBar() {
  const [run, setRun] = useState<RunState | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearHide = () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };

    const offStart = window.api.workflow.onRunStarted((e) => {
      clearHide();
      setRun({ runId: e.runId, workflowId: e.workflowId, name: `工作流 #${e.workflowId}`, step: '准备中', status: 'running' });
      // 异步补真实名字 (期间若已被新 run 取代则不覆盖)
      void window.api.workflow.get(e.workflowId).then((wf) => {
        setRun((cur) => (cur && cur.runId === e.runId ? { ...cur, name: wf?.name ?? cur.name } : cur));
      });
    });

    const offStep = window.api.workflow.onRunStepUpdate((e) => {
      setRun((cur) =>
        cur && cur.runId === e.runId
          ? { ...cur, step: (STEP_LABELS[e.step.step] ?? e.step.step) + (e.step.error ? ' (失败)' : '') }
          : cur,
      );
    });

    const offFin = window.api.workflow.onRunFinished((e) => {
      setRun((cur) =>
        cur && cur.runId === e.runId
          ? { ...cur, status: e.status as RunState['status'], step: e.failReason ?? '' }
          : cur,
      );
      clearHide();
      // 结束后短暂保留再淡出 (期间没有新 run 才清)
      hideTimer.current = setTimeout(() => {
        setRun((cur) => (cur && cur.runId === e.runId ? null : cur));
      }, 6000);
    });

    return () => {
      offStart?.();
      offStep?.();
      offFin?.();
      clearHide();
    };
  }, []);

  const handleStop = () => {
    if (!run || run.status !== 'running') return;
    setRun((cur) => (cur ? { ...cur, stopping: true, step: '停止中…' } : cur));
    void window.api.workflow.stop(run.workflowId);
  };

  if (!run) return null;

  const tail =
    run.status === 'running'
      ? run.step
        ? `· ${run.step}`
        : '· 执行中'
      : (STATUS_TEXT[run.status] ?? run.status) + (run.step ? ` · ${run.step}` : '');

  return (
    <div className={`run-status run-status--${run.status}`}>
      <span className="run-status__dot" />
      <span className="run-status__label">{run.status === 'running' ? '正在执行' : '工作流'}</span>
      <span className="run-status__name">{run.name}</span>
      <span className="run-status__step">{tail}</span>
      {run.status === 'running' && (
        <button className="run-status__stop" onClick={handleStop} disabled={run.stopping} title="停止此工作流">
          {run.stopping ? '停止中…' : '⏹ 停止'}
        </button>
      )}
    </div>
  );
}
