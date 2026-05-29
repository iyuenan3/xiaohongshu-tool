import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

interface ProfileConstraints {
  pub_per_week: number;
  active_hours: string;
  taboo: string[];
  tone: string;
  free_text?: string;
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

export default function OperatingPanel() {
  const [id, setId] = useState<number | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [status, setStatus] = useState<'draft' | 'active' | 'paused'>('draft');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    void window.api.operating.getActiveProfile().then((p) => {
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
        // 保存即生效 (M1: 通常只有一个画像)
        status: 'active',
      });
      setId(saved.id);
      setStatus(saved.status);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 720, margin: '0 auto', overflowY: 'auto', height: '100%' }}>
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

      <p style={{ color: 'var(--ink-mute)', fontSize: 12, marginTop: 24, borderTop: '1px solid var(--border, #2a2a2a)', paddingTop: 16 }}>
        下一步（开发中）：保存画像后，这里会出现「生成本周运营计划」按钮，AI 据画像 + 你的账号数据 + 素材库规划一周行动。
      </p>
    </div>
  );
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
