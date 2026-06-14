import { useEffect, useState, type CSSProperties } from 'react';

interface Pending {
  id: number;
  title: string | null;
  content: string | null;
  images: string | null;
  tags: string | null;
  ai_reason: string | null;
  status: string;
  created_at: number;
  auto_publish_at?: number | null; // P3: 非 null = 全自动审核窗口到点时刻
}

function jsonArr(s: string | null): string[] {
  try {
    return JSON.parse(s || '[]') as string[];
  } catch {
    return [];
  }
}

// P3: 格式化自动发布时刻; 已过窗口则提示即将发
function fmtAuto(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  const when = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return ts <= Date.now() ? `${when}（窗口已到，即将自动发布）` : when;
}

export default function PendingPublishQueue() {
  const [list, setList] = useState<Pending[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = () => {
    void window.api.operating.listPending().then(setList);
  };
  useEffect(() => {
    refresh();
    // 后台 planned_publish 到点拟稿写入新待审后, 自动刷新拉取 (否则第二条永不出现, 用户误判"失败")
    const off = window.api.workflow.onRunFinished((e) => {
      if (e.status === 'success' || e.status === 'partial') {
        setMsg(null); // 清掉上次 approve/reject 的旧提示, 避免与刷新后的新列表状态并存矛盾
        refresh();
      }
    });
    // P3: 全自动发/转人工后台改动待审 → 刷新
    const offPending = window.api.operating.onPendingChanged(() => { setMsg(null); refresh(); });
    return () => { off?.(); offPending?.(); };
  }, []);

  const approve = async (id: number) => {
    setBusy(id);
    setMsg(null);
    try {
      const r = await window.api.operating.approvePublish(id);
      setMsg(r.ok ? '✓ 已发布到小红书' : `发布失败：${r.error ?? '未知'}`);
      refresh();
    } finally {
      setBusy(null);
    }
  };

  const reject = async (id: number) => {
    setBusy(id);
    try {
      await window.api.operating.rejectPending(id);
      refresh();
    } finally {
      setBusy(null);
    }
  };

  const saveEdit = (id: number, patch: { title?: string; content?: string }) => {
    void window.api.operating.updatePending(id, patch);
  };

  // 注意: 不要在空列表时 return null, 否则第一篇审核通过后整个窗口连标题一起消失,
  // 用户以为"审核窗口没了"。改为常驻 + 空态占位 (告诉用户入口还在、AI 到点会再拟稿)。
  return (
    <div style={{ marginTop: 28, borderTop: '1px solid var(--rule)', paddingTop: 20 }}>
      <h3 style={{ margin: 0 }}>待审发布{list.length > 0 ? ` (${list.length})` : ''}</h3>
      {list.length === 0 ? (
        <p style={{ color: 'var(--ink-mute)', fontSize: 12, marginTop: 6 }}>
          暂无待审发布。AI 按运营计划到点拟好笔记后，会自动出现在这里等你确认（发布始终需人工确认）。
        </p>
      ) : (
        <p style={{ color: 'var(--ink-mute)', fontSize: 12, marginTop: 6 }}>
          AI 按运营计划拟好的笔记。你可以改标题 / 正文，确认后才会真正发布到小红书（发布需人工确认）。
        </p>
      )}
      {msg && (
        <p style={{ fontSize: 13, color: msg.startsWith('✓') ? 'var(--green)' : 'var(--accent)' }}>{msg}</p>
      )}
      {list.map((p) => {
        const imgCount = jsonArr(p.images).length;
        const tags = jsonArr(p.tags);
        return (
          <div key={p.id} style={cardStyle}>
            <input
              defaultValue={p.title ?? ''}
              onBlur={(e) => saveEdit(p.id, { title: e.target.value })}
              placeholder="标题"
              style={titleStyle}
            />
            <textarea
              defaultValue={p.content ?? ''}
              onBlur={(e) => saveEdit(p.id, { content: e.target.value })}
              placeholder="正文"
              rows={4}
              style={contentStyle}
            />
            <div style={{ fontSize: 12, color: 'var(--ink-mute)', margin: '8px 0' }}>
              🖼 {imgCount} 图 · 🏷 {tags.length ? tags.join(' ') : '无标签'}
              {p.ai_reason ? ` · 💡 ${p.ai_reason}` : ''}
              {imgCount === 0 && <span style={{ color: 'var(--accent)' }}> · ⚠️ 无配图，需先在素材库补图</span>}
            </div>
            {p.auto_publish_at && (
              <div style={{ fontSize: 12, color: 'var(--accent)', margin: '0 0 8px' }}>
                ⏱ 全自动：将于 {fmtAuto(p.auto_publish_at)} 自动发布（在此之前点「拒绝」即可否决）
              </div>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => approve(p.id)} disabled={busy === p.id} style={approveBtn}>
                {busy === p.id ? '处理中…' : '确认发布'}
              </button>
              <button onClick={() => reject(p.id)} disabled={busy === p.id} style={rejectBtn}>
                {p.auto_publish_at ? '拒绝（否决自动发）' : '拒绝'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const cardStyle: CSSProperties = {
  border: '1px solid var(--rule)', borderRadius: 8, padding: 14, marginTop: 12,
  background: 'var(--paper)',
};
const titleStyle: CSSProperties = {
  width: '100%', padding: '6px 8px', fontSize: 14, fontWeight: 600, borderRadius: 6,
  border: '1px solid var(--rule)', background: 'var(--surface)', color: 'var(--ink)',
  boxSizing: 'border-box', marginBottom: 8,
};
const contentStyle: CSSProperties = {
  width: '100%', padding: '6px 8px', fontSize: 13, lineHeight: 1.5, borderRadius: 6, resize: 'vertical',
  border: '1px solid var(--rule)', background: 'var(--surface)', color: 'var(--ink)',
  boxSizing: 'border-box',
};
const approveBtn: CSSProperties = {
  padding: '7px 18px', fontSize: 13, fontWeight: 600, borderRadius: 6, cursor: 'pointer',
  border: 'none', background: 'var(--accent)', color: '#fff',
};
const rejectBtn: CSSProperties = {
  padding: '7px 18px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
  border: '1px solid var(--rule)', background: 'transparent', color: 'var(--ink-mute)',
};
