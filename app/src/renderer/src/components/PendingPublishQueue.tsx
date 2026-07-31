import { useEffect, useState, type CSSProperties } from 'react';
import AttachmentPicker from './AttachmentPicker';

interface Pending {
  id: number;
  title: string | null;
  content: string | null;
  images: string | null;
  tags: string | null;
  ai_reason: string | null;
  status: 'pending' | 'unknown';
  created_at: number;
  auto_publish_at?: number | null;
}

type PendingPatch = { title?: string; content?: string; images?: string[]; tags?: string[] };

function jsonArr(s: string | null): string[] {
  try {
    const parsed = JSON.parse(s || '[]') as unknown;
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : [];
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
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    const next = await window.api.operating.listPending();
    setList(next as Pending[]);
  };

  useEffect(() => {
    void refresh();
    // 后台 planned_publish 到点拟稿写入新待审后, 自动刷新拉取
    const off = window.api.workflow.onRunFinished((e) => {
      if (e.status === 'success' || e.status === 'partial') {
        setMsg(null);
        void refresh();
      }
    });
    // P3: 全自动发或转待核对后刷新
    const offPending = window.api.operating.onPendingChanged(() => {
      setMsg(null);
      void refresh();
    });
    return () => { off?.(); offPending?.(); };
  }, []);

  const approve = async (id: number) => {
    setBusy(id);
    setMsg(null);
    try {
      const r = await window.api.operating.approvePublish(id);
      setMsg(r.ok ? '✓ 已发布到小红书' : `发布失败：${r.error ?? '未知错误'}`);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const reject = async (id: number) => {
    setBusy(id);
    setMsg(null);
    try {
      const r = await window.api.operating.rejectPending(id);
      if (!r.ok && r.reason === 'publishing') setMsg('该笔记正在发布中，已无法撤销');
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const saveEdit = async (id: number, patch: PendingPatch): Promise<boolean> => {
    setBusy(id);
    setMsg(null);
    try {
      const r = await window.api.operating.updatePending(id, patch);
      if (!r.ok) setMsg(r.error ?? '保存失败，请刷新后重试');
      await refresh();
      return r.ok;
    } finally {
      setBusy(null);
    }
  };

  const resolveUnknown = async (id: number, outcome: 'published' | 'not_published') => {
    setBusy(id);
    setMsg(null);
    try {
      const r = await window.api.operating.resolvePublishUnknown(id, outcome);
      if (r.ok) {
        setMsg(outcome === 'published' ? '✓ 已记录为发布成功' : '✓ 已重新开放确认发布');
      } else {
        setMsg(r.error ?? '核对结果保存失败');
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const updateImages = (id: number, images: string[]) => saveEdit(id, { images });

  return (
    <div style={{ marginTop: 28, borderTop: '1px solid var(--rule)', paddingTop: 20 }}>
      <h3 style={{ margin: 0 }}>待审与待核对{list.length > 0 ? ` (${list.length})` : ''}</h3>
      {list.length === 0 ? (
        <p style={hintStyle}>
          暂无待处理笔记。自动模式会先保留审核窗口，人工模式会一直等待你确认。
        </p>
      ) : (
        <p style={hintStyle}>
          发布前可预览、换图、排序和设置封面。自动散图默认 1 张，手动策展的素材分组仍可整组发布。
        </p>
      )}
      {msg && (
        <p style={{ fontSize: 13, color: msg.startsWith('✓') ? 'var(--green)' : 'var(--accent)' }}>{msg}</p>
      )}
      {list.map((p) => {
        const images = jsonArr(p.images);
        const tags = jsonArr(p.tags);
        const isUnknown = p.status === 'unknown';
        return (
          <div key={`${p.id}:${p.status}:${p.images ?? ''}`} style={cardStyle}>
            {isUnknown && (
              <div style={unknownStyle}>
                <strong>发布结果未知，已禁止直接重试</strong>
                <div style={{ marginTop: 4 }}>请先到小红书个人主页核对这篇笔记，再选择下方结果。</div>
              </div>
            )}
            <input
              defaultValue={p.title ?? ''}
              onBlur={(e) => { if (!isUnknown && e.target.value !== (p.title ?? '')) void saveEdit(p.id, { title: e.target.value }); }}
              placeholder="标题"
              disabled={isUnknown || busy === p.id}
              style={titleStyle}
            />
            <textarea
              defaultValue={p.content ?? ''}
              onBlur={(e) => { if (!isUnknown && e.target.value !== (p.content ?? '')) void saveEdit(p.id, { content: e.target.value }); }}
              placeholder="正文"
              rows={4}
              disabled={isUnknown || busy === p.id}
              style={contentStyle}
            />

            <div style={imageGridStyle}>
              {images.map((id, index) => (
                <div key={`${id}:${index}`} style={imageCardStyle}>
                  <img src={`xhs-asset://${id}`} alt={`配图 ${index + 1}`} style={imageStyle} />
                  <span style={imageBadgeStyle}>{index === 0 ? '封面' : index + 1}</span>
                  {!isUnknown && (
                    <div style={imageActionsStyle}>
                      {index > 0 && (
                        <button type="button" style={miniBtn} onClick={() => void updateImages(p.id, [id, ...images.filter((_, i) => i !== index)])}>
                          设封面
                        </button>
                      )}
                      <button
                        type="button"
                        style={miniBtn}
                        disabled={index === 0 || busy === p.id}
                        onClick={() => {
                          const next = [...images];
                          [next[index - 1], next[index]] = [next[index], next[index - 1]];
                          void updateImages(p.id, next);
                        }}
                      >
                        左移
                      </button>
                      <button
                        type="button"
                        style={miniBtn}
                        disabled={index === images.length - 1 || busy === p.id}
                        onClick={() => {
                          const next = [...images];
                          [next[index], next[index + 1]] = [next[index + 1], next[index]];
                          void updateImages(p.id, next);
                        }}
                      >
                        右移
                      </button>
                      <button
                        type="button"
                        style={{ ...miniBtn, color: 'var(--accent)' }}
                        disabled={busy === p.id}
                        onClick={() => void updateImages(p.id, images.filter((_, i) => i !== index))}
                      >
                        移除
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {!isUnknown && (
                <button type="button" style={addImageBtn} disabled={busy === p.id} onClick={() => setPickerFor(p.id)}>
                  {images.length ? '换图或加图' : '选择配图'}
                </button>
              )}
            </div>

            <div style={{ fontSize: 12, color: 'var(--ink-mute)', margin: '8px 0' }}>
              🖼 {images.length} 图 · 🏷 {tags.length ? tags.join(' ') : '无标签'}
              {p.ai_reason ? ` · 💡 ${p.ai_reason}` : ''}
              {images.length === 0 && <span style={{ color: 'var(--accent)' }}> · ⚠️ 无配图，发布护栏会拦截</span>}
            </div>
            {!isUnknown && p.auto_publish_at && (
              <div style={{ fontSize: 12, color: 'var(--accent)', margin: '0 0 8px' }}>
                ⏱ 全自动：将于 {fmtAuto(p.auto_publish_at)} 自动发布。编辑内容或配图后，审核窗口会重新计时。
              </div>
            )}
            {isUnknown ? (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button
                  onClick={() => void resolveUnknown(p.id, 'published')}
                  disabled={busy === p.id}
                  style={approveBtn}
                >
                  核对：已经发布
                </button>
                <button
                  onClick={() => void resolveUnknown(p.id, 'not_published')}
                  disabled={busy === p.id}
                  style={rejectBtn}
                >
                  核对：没有发布，允许重试
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => void approve(p.id)} disabled={busy === p.id} style={approveBtn}>
                  {busy === p.id ? '处理中…' : '确认发布'}
                </button>
                <button onClick={() => void reject(p.id)} disabled={busy === p.id} style={rejectBtn}>
                  {p.auto_publish_at ? '拒绝（否决自动发）' : '拒绝'}
                </button>
              </div>
            )}
          </div>
        );
      })}

      {pickerFor !== null && (() => {
        const pending = list.find((p) => p.id === pickerFor);
        const current = jsonArr(pending?.images ?? null);
        return (
          <AttachmentPicker
            initialSelected={current}
            onClose={() => setPickerFor(null)}
            onConfirm={(assets) => {
              const selected = assets.map((a) => a.id);
              const ordered = [...current.filter((id) => selected.includes(id)), ...selected.filter((id) => !current.includes(id))];
              const id = pickerFor;
              setPickerFor(null);
              void updateImages(id, ordered);
            }}
          />
        );
      })()}
    </div>
  );
}

const hintStyle: CSSProperties = { color: 'var(--ink-mute)', fontSize: 12, marginTop: 6 };
const cardStyle: CSSProperties = {
  border: '1px solid var(--rule)', borderRadius: 8, padding: 14, marginTop: 12,
  background: 'var(--paper)',
};
const unknownStyle: CSSProperties = {
  padding: '10px 12px', marginBottom: 10, borderRadius: 6, fontSize: 12,
  color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 9%, transparent)',
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
const imageGridStyle: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginTop: 10,
};
const imageCardStyle: CSSProperties = {
  position: 'relative', minWidth: 0, border: '1px solid var(--rule)', borderRadius: 7,
  overflow: 'hidden', background: 'var(--surface)',
};
const imageStyle: CSSProperties = { display: 'block', width: '100%', height: 118, objectFit: 'cover' };
const imageBadgeStyle: CSSProperties = {
  position: 'absolute', top: 6, left: 6, padding: '2px 6px', borderRadius: 10,
  background: 'rgba(0, 0, 0, .62)', color: '#fff', fontSize: 11,
};
const imageActionsStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4, padding: 6 };
const miniBtn: CSSProperties = {
  padding: '3px 6px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
  border: '1px solid var(--rule)', background: 'transparent', color: 'var(--ink-mute)',
};
const addImageBtn: CSSProperties = {
  minHeight: 118, border: '1px dashed var(--rule)', borderRadius: 7, cursor: 'pointer',
  background: 'var(--surface)', color: 'var(--ink-mute)', fontSize: 12,
};
const approveBtn: CSSProperties = {
  padding: '7px 18px', fontSize: 13, fontWeight: 600, borderRadius: 6, cursor: 'pointer',
  border: 'none', background: 'var(--accent)', color: '#fff',
};
const rejectBtn: CSSProperties = {
  padding: '7px 18px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
  border: '1px solid var(--rule)', background: 'transparent', color: 'var(--ink-mute)',
};
