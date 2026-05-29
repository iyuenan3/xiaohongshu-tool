import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import PendingPublishQueue from './PendingPublishQueue';

interface ProfileConstraints {
  pub_per_week: number;
  active_hours: string;
  taboo: string[];
  tone: string;
  free_text?: string;
}

interface ActionRow {
  id: number;
  plan_id: number;
  scheduled_at: number;
  type: 'browse' | 'interact' | 'publish';
  spec: string;
  workflow_id: number | null;
  status: string;
  created_at: number;
}

const EMPTY = {
  direction: '',
  persona: '',
  pub_per_week: 3,
  active_hours: '19:00-21:00',
  tone: '',
  taboo: '',
  free_text: '',
  asset_tags: '',
};

const TYPE_META: Record<string, { emoji: string; label: string }> = {
  browse: { emoji: '👀', label: '刷垂类' },
  interact: { emoji: '💬', label: '互动' },
  publish: { emoji: '✍️', label: '发布' },
};

export default function OperatingPanel() {
  const [id, setId] = useState<number | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [status, setStatus] = useState<'draft' | 'active' | 'paused'>('draft');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // 运营计划 (M2)
  const [planRationale, setPlanRationale] = useState<string | null>(null);
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [planId, setPlanId] = useState<number | null>(null);
  const [activating, setActivating] = useState(false);
  const [activateMsg, setActivateMsg] = useState<string | null>(null);
  const [planActivated, setPlanActivated] = useState(false);

  useEffect(() => {
    void window.api.operating.getActiveProfile().then(async (p) => {
      if (!p) return;
      const c = JSON.parse(p.constraints || '{}') as ProfileConstraints;
      const tags = JSON.parse(p.asset_tags || '[]') as string[];
      setId(p.id);
      setStatus(p.status);
      setForm({
        direction: p.direction,
        persona: p.persona ?? '',
        pub_per_week: c.pub_per_week ?? 3,
        active_hours: c.active_hours ?? '19:00-21:00',
        tone: c.tone ?? '',
        taboo: (c.taboo ?? []).join(', '),
        free_text: c.free_text ?? '',
        asset_tags: tags.join(', '),
      });
      // 计划按当前画像过滤, 避免换画像后混搭到旧画像的计划
      const plan = await window.api.operating.getLatestPlan(p.id);
      if (plan) {
        setPlanId(plan.id);
        setPlanRationale(plan.rationale);
        setActions(await window.api.operating.listActions(plan.id));
        if (plan.status === 'active') {
          setActivateMsg('此计划已激活');
          setPlanActivated(true);
        }
      }
    });
  }, []);

  const upd = (k: keyof typeof form, v: string | number) => setForm((f) => ({ ...f, [k]: v }));
  const splitList = (s: string) => s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);

  const save = async () => {
    if (!form.direction.trim()) {
      alert('请先填写运营方向 / 赛道');
      return;
    }
    setSaving(true);
    try {
      const saved = await window.api.operating.saveProfile({
        ...(id ? { id } : {}),
        direction: form.direction.trim(),
        persona: form.persona.trim() || null,
        constraints: {
          pub_per_week: Number(form.pub_per_week) || 3,
          active_hours: form.active_hours.trim(),
          tone: form.tone.trim(),
          taboo: splitList(form.taboo),
          free_text: form.free_text.trim() || undefined,
        },
        asset_tags: splitList(form.asset_tags),
        status: 'active',
      });
      setId(saved.id);
      setStatus(saved.status);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  const generate = async () => {
    setGenerating(true);
    setGenError(null);
    try {
      const r = await window.api.operating.generatePlan(7);
      if (!r.ok) {
        setGenError(r.error);
        return;
      }
      const p = await window.api.operating.getLatestPlan();
      if (p) {
        setPlanId(p.id);
        setPlanRationale(p.rationale);
        setActions(await window.api.operating.listActions(p.id));
        setActivateMsg(null);
        setPlanActivated(false);
      }
    } finally {
      setGenerating(false);
    }
  };

  const activate = async () => {
    if (!planId) return;
    setActivating(true);
    setActivateMsg(null);
    try {
      const r = await window.api.operating.activatePlan(planId);
      if (!r.ok) {
        setActivateMsg(`激活失败：${r.error ?? '未知'}`);
        return;
      }
      const parts = [`已排 ${r.created} 个互动任务进自动调度`];
      if (r.pendingPublish > 0) parts.push(`${r.pendingPublish} 个发布已排程（到点拟稿进待审）`);
      if (r.skipped > 0) parts.push(`${r.skipped} 个跳过（浏览类暂未支持）`);
      setActivateMsg('✓ ' + parts.join('；'));
      setPlanActivated(true);
      setActions(await window.api.operating.listActions(planId));
    } finally {
      setActivating(false);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 760, margin: '0 auto', overflowY: 'auto', height: '100%' }}>
      <h2 style={{ marginTop: 0 }}>自主运营 · 账号画像</h2>
      <p style={{ color: 'var(--ink-mute)', fontSize: 13, lineHeight: 1.6 }}>
        告诉 xhsPilot 你的账号方向、人设和限定，之后 AI 会据此规划「何时刷垂类、何时发笔记、如何互动」。
        互动（刷 / 点赞 / 评论）全自动执行；发布笔记 AI 拟好后进待审队列，你确认才发。
      </p>

      <Field label="运营方向 / 赛道 *" hint="如「云南果园生活」「平价美妆测评」">
        <input value={form.direction} onChange={(e) => upd('direction', e.target.value)} placeholder="一句话描述这个账号做什么" style={inputStyle} />
      </Field>

      <Field label="人设 / 调性" hint="如「真实、治愈、慢生活」">
        <input value={form.persona} onChange={(e) => upd('persona', e.target.value)} placeholder="账号的人格与风格" style={inputStyle} />
      </Field>

      <div style={{ display: 'flex', gap: 16 }}>
        <Field label="每周发布上限" hint="条 / 周">
          <input type="number" min={0} max={21} value={form.pub_per_week} onChange={(e) => upd('pub_per_week', e.target.value)} style={inputStyle} />
        </Field>
        <Field label="活跃时段" hint="如 19:00-21:00">
          <input value={form.active_hours} onChange={(e) => upd('active_hours', e.target.value)} style={inputStyle} />
        </Field>
      </div>

      <Field label="内容调性关键词" hint="逗号分隔，影响文案风格">
        <input value={form.tone} onChange={(e) => upd('tone', e.target.value)} placeholder="治愈, 真实, 口语化" style={inputStyle} />
      </Field>

      <Field label="禁忌 / 避免" hint="逗号分隔，AI 不会涉及">
        <input value={form.taboo} onChange={(e) => upd('taboo', e.target.value)} placeholder="硬广, 夸大功效, 敏感话题" style={inputStyle} />
      </Field>

      <Field label="素材标签范围" hint="逗号分隔，限定 AI 选图的素材标签（空 = 全部）">
        <input value={form.asset_tags} onChange={(e) => upd('asset_tags', e.target.value)} placeholder="樱花, 果园, 猫" style={inputStyle} />
      </Field>

      <Field label="自由补充" hint="表单之外想让 AI 知道的">
        <textarea value={form.free_text} onChange={(e) => upd('free_text', e.target.value)} rows={3} placeholder="如：周末多发；多用互动提问结尾…" style={{ ...inputStyle, resize: 'vertical' }} />
      </Field>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
        <button onClick={save} disabled={saving} style={btnStyle}>{saving ? '保存中…' : '保存画像'}</button>
        {savedAt && <span style={{ color: 'var(--green)', fontSize: 13 }}>✓ 已保存</span>}
        {id && <span style={{ color: 'var(--ink-mute)', fontSize: 12 }}>画像 #{id} · {status}</span>}
      </div>

      {/* 运营计划 (M2) */}
      <div style={{ marginTop: 28, borderTop: '1px solid var(--border, #2a2a2a)', paddingTop: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>本周运营计划</h3>
          <button onClick={generate} disabled={generating || !id} style={btnStyle} title={!id ? '请先保存画像' : ''}>
            {generating ? 'AI 规划中…（约 10-30s）' : actions.length ? '重新生成计划' : '生成本周计划'}
          </button>
        </div>

        {genError && (
          <p style={{ color: 'var(--accent, #FF2442)', fontSize: 13, marginTop: 12 }}>{genError}</p>
        )}

        {planRationale && (
          <p style={{ color: 'var(--ink-mute)', fontSize: 13, lineHeight: 1.6, marginTop: 12, padding: '10px 12px', background: 'var(--bg-input, #1a1a1a)', borderRadius: 6 }}>
            💡 {planRationale}
          </p>
        )}

        {actions.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            {actions.map((a) => (
              <div key={a.id} style={rowStyle}>
                <span style={{ fontSize: 12, color: 'var(--ink-mute)', minWidth: 92 }}>{fmtTime(a.scheduled_at)}</span>
                <span style={{ fontSize: 14 }}>{TYPE_META[a.type]?.emoji ?? '•'}</span>
                <span style={{ flex: 1, fontSize: 13 }}>{actionSummary(a.type, a.spec)}</span>
                {a.type === 'publish' && (
                  <span style={{ fontSize: 11, color: 'var(--accent, #FF2442)' }}>发布待确认</span>
                )}
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
              <button onClick={activate} disabled={activating || !planId || planActivated} style={btnStyle}>
                {activating ? '激活中…' : planActivated ? '已激活' : '激活计划（互动自动执行）'}
              </button>
              {activateMsg && (
                <span style={{ fontSize: 12, color: activateMsg.startsWith('✓') || activateMsg.includes('已激活') ? 'var(--green)' : 'var(--accent, #FF2442)' }}>
                  {activateMsg}
                </span>
              )}
            </div>
            <p style={{ color: 'var(--ink-mute)', fontSize: 12, marginTop: 10 }}>
              激活后：互动类（💬）按计划时间自动执行；发布类（✍️）到点拟稿进下方「待审发布」，你确认后才发；浏览类（👀）暂未支持。
            </p>
          </div>
        ) : (
          !planRationale && (
            <p style={{ color: 'var(--ink-mute)', fontSize: 13, marginTop: 12 }}>
              {id ? '点「生成本周计划」，AI 会据画像 + 账号数据 + 素材库排一周行动。' : '请先保存账号画像。'}
            </p>
          )
        )}
      </div>

      <PendingPublishQueue />
    </div>
  );
}

function actionSummary(type: string, specJson: string): string {
  try {
    const s = JSON.parse(specJson) as Record<string, unknown>;
    if (type === 'browse') return `刷「${s.keyword}」${s.count ?? '?'} 篇`;
    if (type === 'interact') {
      const like = Math.min(Number(s.like ?? 0) || 0, 5); // 模板硬上限: 点赞 ≤5
      const comment = Math.min(Number(s.comment ?? 0) || 0, 3); // 评论 ≤3
      return `互动「${s.keyword}」点赞 ${like} · 评论 ${comment}`;
    }
    if (type === 'publish') return `发布：${(s.title as string) || (s.theme as string) || '笔记'}`;
    return type;
  } catch {
    return type;
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 14, flex: 1 }}>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{label}</label>
      {hint && <div style={{ fontSize: 11, color: 'var(--ink-mute)', marginBottom: 4 }}>{hint}</div>}
      {children}
    </div>
  );
}

const inputStyle: CSSProperties = {
  width: '100%', padding: '8px 10px', fontSize: 13, borderRadius: 6,
  border: '1px solid var(--border, #333)', background: 'var(--bg-input, #1a1a1a)', color: 'var(--ink, #eee)',
  boxSizing: 'border-box',
};
const btnStyle: CSSProperties = {
  padding: '8px 20px', fontSize: 14, fontWeight: 600, borderRadius: 6, cursor: 'pointer',
  border: 'none', background: 'var(--accent, #FF2442)', color: '#fff',
};
const rowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
  borderBottom: '1px solid var(--border, #222)',
};
