import { useEffect, useState } from 'react';
import { formatSchedule, formatNextFire, statusPill, type WorkflowP } from '../lib/workflow';
import WorkflowEditor from './WorkflowEditor';
import WorkflowRunHistory from './WorkflowRunHistory';
import RiskWarningDialog from './RiskWarningDialog';

const RISK_KEY = 'workflow_risk_accepted';

export default function WorkflowList({ onShowHelp }: { onShowHelp?: () => void }) {
  const [list, setList] = useState<WorkflowP[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [historyOpenFor, setHistoryOpenFor] = useState<number | null>(null);
  const [riskOpen, setRiskOpen] = useState(false);
  const [pendingEnableId, setPendingEnableId] = useState<number | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [runningIds, setRunningIds] = useState<Set<number>>(new Set());
  const [queuedIds, setQueuedIds] = useState<Set<number>>(new Set());

  const refresh = async () => {
    const l = await window.api.workflow.list();
    setList(l);
  };

  useEffect(() => {
    void refresh();
    const offFin = window.api.workflow.onRunFinished((e) => {
      setRunningIds((prev) => { const next = new Set(prev); next.delete(e.workflowId); return next; });
      setQueuedIds((prev) => { const next = new Set(prev); next.delete(e.workflowId); return next; });
      void refresh();
    });
    const offStart = window.api.workflow.onRunStarted((e) => {
      setRunningIds((prev) => new Set(prev).add(e.workflowId));
      setQueuedIds((prev) => { const next = new Set(prev); next.delete(e.workflowId); return next; });
      void refresh();
    });
    const offDisabled = window.api.workflow.onAutoDisabled(() => { void refresh(); });
    return () => { offFin(); offStart(); offDisabled(); };
  }, []);

  const handleNew = async () => {
    // 首次创建工作流: 先弹风险确认, 接受后才打开编辑器
    const accepted = await window.api.workflow.getConfig(RISK_KEY);
    if (accepted !== '1') {
      setPendingEnableId(null);  // 不是 enable 触发, 是 new 触发
      setRiskOpen(true);
      return;
    }
    setEditingId(null);
    setEditorOpen(true);
  };

  const handleEdit = (id: number) => {
    setEditingId(id);
    setEditorOpen(true);
    setMenuOpenId(null);
  };

  const handleSaved = async (_wfId: number) => {
    setEditorOpen(false);
    await refresh();
  };

  const handleRiskAccept = async () => {
    await window.api.workflow.setConfig(RISK_KEY, '1');
    setRiskOpen(false);
    if (pendingEnableId !== null) {
      // 风险接受来自 toggle enable 流程: 恢复启用
      await window.api.workflow.enable(pendingEnableId, true);
      setPendingEnableId(null);
      await refresh();
    } else {
      // 风险接受来自 new 流程: 打开编辑器
      setEditingId(null);
      setEditorOpen(true);
    }
  };

  const handleRiskCancel = () => {
    setRiskOpen(false);
    setPendingEnableId(null);
  };

  const handleToggleEnable = async (wf: WorkflowP) => {
    const turnOn = wf.enabled !== 1;
    if (turnOn) {
      const accepted = await window.api.workflow.getConfig(RISK_KEY);
      if (accepted !== '1') {
        setPendingEnableId(wf.id);
        setRiskOpen(true);
        return;
      }
    }
    await window.api.workflow.enable(wf.id, turnOn);
    await refresh();
    setMenuOpenId(null);
  };

  const handleRunNow = async (id: number) => {
    // 即时本地 hint: 进入 queue 状态 (实际是否 running / queue 主进程会通过 onRunStarted push 校正)
    setQueuedIds((prev) => new Set(prev).add(id));
    await window.api.workflow.runNow(id);
    setMenuOpenId(null);
    setTimeout(() => { void refresh(); }, 200);
  };

  const handleStop = async (id: number) => {
    // 运行中→主进程 abort, 等 run-finished(aborted) 清 runningIds; 排队中→即时移除本地标记
    setQueuedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    await window.api.workflow.stop(id);
    setTimeout(() => { void refresh(); }, 200);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('删除该工作流? 运行历史会保留。')) return;
    await window.api.workflow.delete(id);
    await refresh();
    setMenuOpenId(null);
  };

  return (
    <section className="workflow-pane">
      <header className="pane-heading-row">
        <h3 className="pane-heading">🎛 工作流</h3>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {onShowHelp && (
            <button className="pane-action-btn" onClick={onShowHelp} title="工作流怎么用? 看帮助">?</button>
          )}
          <button className="pane-action-btn" onClick={handleNew} title="新建工作流">+ 新建</button>
        </div>
      </header>
      <div className="workflow-list">
        {list.length === 0 ? (
          <div className="workflow-empty">还没有工作流, 点上方"+ 新建"创建一个</div>
        ) : (
          list.map((wf) => {
            const pill = statusPill(wf);
            const isRunning = runningIds.has(wf.id);
            const isQueued = queuedIds.has(wf.id) && !isRunning;
            return (
              <div key={wf.id} className="workflow-row">
                <div className="workflow-row__main" onClick={() => handleEdit(wf.id)} role="button" tabIndex={0}>
                  <div className="workflow-row__line1">
                    <span className="workflow-row__name">{wf.name}</span>
                    {isRunning && <span className="workflow-pill workflow-pill--warn">🔄 运行中</span>}
                    {isQueued && <span className="workflow-pill workflow-pill--mute">📋 排队中</span>}
                    {!isRunning && !isQueued && (
                      <span className={`workflow-pill workflow-pill--${pill.tone}`}>{pill.text}</span>
                    )}
                  </div>
                  <div className="workflow-row__line2">
                    <span className="workflow-row__sched">{formatSchedule(wf.schedule)}</span>
                    {wf.enabled === 1 && wf.next_fire_at && (
                      <span className="workflow-row__next">下次 {formatNextFire(wf.next_fire_at)}</span>
                    )}
                  </div>
                </div>
                <div className="workflow-row__actions">
                  {isRunning || isQueued ? (
                    <button
                      className="workflow-icon-btn"
                      title="停止"
                      onClick={(e) => { e.stopPropagation(); void handleStop(wf.id); }}
                    >⏹</button>
                  ) : (
                    <button
                      className="workflow-icon-btn"
                      title="立即执行 (跳过调度)"
                      onClick={(e) => { e.stopPropagation(); void handleRunNow(wf.id); }}
                    >▶</button>
                  )}
                  <button
                    className="workflow-icon-btn"
                    title="更多"
                    onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === wf.id ? null : wf.id); }}
                  >⋮</button>
                  {menuOpenId === wf.id && (
                    <div className="workflow-menu" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => handleEdit(wf.id)}>编辑</button>
                      <button onClick={() => { setHistoryOpenFor(wf.id); setMenuOpenId(null); }}>运行历史</button>
                      <button onClick={() => void handleToggleEnable(wf)}>
                        {wf.enabled ? '⏸ 暂停' : '▶ 启用'}
                      </button>
                      <button onClick={() => void handleDelete(wf.id)} className="workflow-menu__danger">删除</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
      {editorOpen && (
        <WorkflowEditor
          editingId={editingId}
          onClose={() => setEditorOpen(false)}
          onSaved={handleSaved}
        />
      )}
      {historyOpenFor !== null && (
        <WorkflowRunHistory
          workflowId={historyOpenFor}
          onClose={() => setHistoryOpenFor(null)}
        />
      )}
      {riskOpen && (
        <RiskWarningDialog
          onAccept={handleRiskAccept}
          onCancel={handleRiskCancel}
        />
      )}
    </section>
  );
}
