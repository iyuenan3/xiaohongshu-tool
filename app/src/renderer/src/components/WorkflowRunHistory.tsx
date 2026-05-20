import { useEffect, useState } from 'react';
import { runStatusLabel, type WorkflowRunP } from '../lib/workflow';

interface Props {
  workflowId: number;
  onClose: () => void;
}

export default function WorkflowRunHistory({ workflowId, onClose }: Props) {
  const [runs, setRuns] = useState<WorkflowRunP[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const refresh = async () => {
    const list = await window.api.workflow.runs(workflowId, 100);
    setRuns(list);
  };

  useEffect(() => {
    void refresh();
    const offFin = window.api.workflow.onRunFinished(() => { void refresh(); });
    const offStart = window.api.workflow.onRunStarted(() => { void refresh(); });
    const offStep = window.api.workflow.onRunStepUpdate(() => { void refresh(); });
    return () => { offFin(); offStart(); offStep(); };
  }, [workflowId]);

  const toggleExpand = (id: number) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  const fmtTime = (ts: number | null) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal workflow-history-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>运行历史</h2>
          <button className="close-btn" onClick={onClose} title="关闭">✕</button>
        </header>
        <div className="settings-body">
          {runs.length === 0 ? (
            <p className="hint">还没有运行记录。</p>
          ) : (
            <ul className="workflow-runs">
              {runs.map((r) => {
                const label = runStatusLabel(r);
                const isOpen = expanded.has(r.id);
                let stepCount = 0;
                try { stepCount = (JSON.parse(r.steps_log || '[]') as unknown[]).length; } catch { /* ignore */ }
                return (
                  <li key={r.id} className="workflow-run-row">
                    <div className="workflow-run-row__head" onClick={() => toggleExpand(r.id)}>
                      <span className={`workflow-pill workflow-pill--${label.tone}`}>{label.text}</span>
                      <span className="workflow-run-row__time">{fmtTime(r.started_at)}</span>
                      <span className="workflow-run-row__summary">{r.summary ?? '—'}</span>
                      <span className="workflow-run-row__exp">{isOpen ? '▾' : '▸'}</span>
                    </div>
                    {isOpen && (
                      <div className="workflow-run-row__detail">
                        <div><strong>开始:</strong> {fmtTime(r.started_at)}</div>
                        <div><strong>结束:</strong> {fmtTime(r.finished_at)}</div>
                        <div><strong>步骤数:</strong> {stepCount}</div>
                        {r.fail_reason && <div><strong>失败原因:</strong> {r.fail_reason}</div>}
                        {r.error && <div><strong>错误:</strong> <code>{r.error}</code></div>}
                        {r.steps_log && (
                          <details>
                            <summary>步骤详情</summary>
                            <pre className="workflow-run-row__steps">{r.steps_log}</pre>
                          </details>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
