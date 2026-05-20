import { useEffect, useState } from 'react';
import { getLocalTz, WEEKDAY_OPTIONS, type ScheduleP, type TemplateMetaP, type WorkflowP } from '../lib/workflow';

interface Props {
  editingId: number | null;
  onClose: () => void;
  onSaved: (wfId: number) => void;
}

export default function WorkflowEditor({ editingId, onClose, onSaved }: Props) {
  const [templates, setTemplates] = useState<TemplateMetaP[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [name, setName] = useState('');
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [schedule, setSchedule] = useState<ScheduleP>({
    type: 'daily', hour: 9, minute: 0, jitter_min: 10, tz: getLocalTz(),
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const tpls = await window.api.workflow.getTemplates();
      setTemplates(tpls);
      if (editingId !== null) {
        const wf: WorkflowP | null = await window.api.workflow.get(editingId);
        if (wf) {
          setSelectedTemplateId(wf.template_id);
          setName(wf.name);
          try { setParams(JSON.parse(wf.params) as Record<string, unknown>); } catch { /* ignore */ }
          try { setSchedule(JSON.parse(wf.schedule) as ScheduleP); } catch { /* ignore */ }
        }
      } else if (tpls.length > 0) {
        // 默认选第 1 个模板, 应用 defaults
        const def = tpls[0];
        setSelectedTemplateId(def.id);
        setName(def.name);
        const defaultParams: Record<string, unknown> = {};
        for (const [k, spec] of Object.entries(def.paramsSchema)) {
          if (spec.default !== undefined) defaultParams[k] = spec.default;
        }
        setParams(defaultParams);
      }
    })();
  }, [editingId]);

  const handleTemplateChange = (id: string) => {
    setSelectedTemplateId(id);
    const tpl = templates.find((t) => t.id === id);
    if (tpl) {
      setName(tpl.name);
      const defaultParams: Record<string, unknown> = {};
      for (const [k, spec] of Object.entries(tpl.paramsSchema)) {
        if (spec.default !== undefined) defaultParams[k] = spec.default;
      }
      setParams(defaultParams);
    }
  };

  const handleSave = async () => {
    if (!selectedTemplateId || !name.trim()) return;
    setSaving(true);
    try {
      if (editingId === null) {
        const wf = await window.api.workflow.create({
          template_id: selectedTemplateId,
          name: name.trim(),
          params,
          schedule,
          enabled: true,
        });
        onSaved(wf.id);
      } else {
        await window.api.workflow.update(editingId, {
          name: name.trim(),
          params,
          schedule,
          enabled: 1,
        });
        onSaved(editingId);
      }
    } catch (e) {
      alert(`保存失败: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const currentTpl = templates.find((t) => t.id === selectedTemplateId);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal workflow-editor-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{editingId === null ? '新建工作流' : '编辑工作流'}</h2>
          <button className="close-btn" onClick={onClose} title="关闭">✕</button>
        </header>
        <div className="settings-body">
          <section className="we-section">
            <h4>① 选择模板</h4>
            <div className="we-template-grid">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`we-template-card ${selectedTemplateId === t.id ? 'we-template-card--selected' : ''}`}
                  onClick={() => handleTemplateChange(t.id)}
                  disabled={editingId !== null}
                  title={t.description}
                >
                  <div className="we-template-card__emoji">{t.emoji}</div>
                  <div className="we-template-card__name">{t.name}</div>
                </button>
              ))}
            </div>
            {currentTpl && <p className="hint">{currentTpl.description}</p>}
          </section>

          <section className="we-section">
            <h4>② 配置参数</h4>
            <label>
              <span>名字</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="给工作流起个名" />
            </label>
            {currentTpl && Object.entries(currentTpl.paramsSchema).map(([key, spec]) => (
              <label key={key}>
                <span>{spec.label}</span>
                {spec.type === 'int' ? (
                  <input
                    type="number"
                    min={spec.min} max={spec.max}
                    value={String(params[key] ?? spec.default ?? '')}
                    onChange={(e) => setParams({ ...params, [key]: Number(e.target.value) })}
                  />
                ) : spec.type === 'enum' ? (
                  <select
                    value={String(params[key] ?? spec.default ?? '')}
                    onChange={(e) => setParams({ ...params, [key]: e.target.value })}
                  >
                    {spec.options?.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={String(params[key] ?? spec.default ?? '')}
                    onChange={(e) => setParams({ ...params, [key]: e.target.value })}
                  />
                )}
              </label>
            ))}
          </section>

          <section className="we-section">
            <h4>③ 调度</h4>
            <label>
              <span>触发方式</span>
              <select
                value={schedule.type}
                onChange={(e) => setSchedule({ ...schedule, type: e.target.value as ScheduleP['type'] })}
              >
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
                <option value="interval">每隔 N 小时</option>
                <option value="manual">手动触发 (不调度)</option>
              </select>
            </label>
            {schedule.type === 'weekly' && (
              <label>
                <span>星期</span>
                <select
                  value={String(schedule.weekday ?? 1)}
                  onChange={(e) => setSchedule({ ...schedule, weekday: Number(e.target.value) })}
                >
                  {WEEKDAY_OPTIONS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                </select>
              </label>
            )}
            {(schedule.type === 'daily' || schedule.type === 'weekly') && (
              <label>
                <span>时间 (HH:MM)</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="number" min={0} max={23} style={{ width: 70 }}
                    value={schedule.hour ?? 9}
                    onChange={(e) => setSchedule({ ...schedule, hour: Number(e.target.value) })}
                  />
                  <span>:</span>
                  <input
                    type="number" min={0} max={59} style={{ width: 70 }}
                    value={schedule.minute ?? 0}
                    onChange={(e) => setSchedule({ ...schedule, minute: Number(e.target.value) })}
                  />
                </div>
              </label>
            )}
            {schedule.type === 'interval' && (
              <label>
                <span>每 N 小时</span>
                <input
                  type="number" min={1} max={72}
                  value={schedule.interval_hours ?? 6}
                  onChange={(e) => setSchedule({ ...schedule, interval_hours: Number(e.target.value) })}
                />
              </label>
            )}
            {schedule.type !== 'manual' && (
              <label>
                <span>防风控抖动 (±N 分钟)</span>
                <input
                  type="number" min={0} max={60}
                  value={schedule.jitter_min ?? 10}
                  onChange={(e) => setSchedule({ ...schedule, jitter_min: Number(e.target.value) })}
                />
              </label>
            )}
            <p className="hint" style={{ fontSize: 11 }}>
              提示: 步骤之间会自动加 30-90 秒随机延迟. 每次最多执行 5 次点赞 + 3 次评论 (代码硬上限)。
            </p>
          </section>

          <div className="settings-actions">
            <button onClick={onClose}>取消</button>
            <button className="primary" onClick={() => void handleSave()} disabled={saving || !name.trim() || !selectedTemplateId}>
              {saving ? '保存中…' : (editingId === null ? '保存 (启用)' : '保存')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
