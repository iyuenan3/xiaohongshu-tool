import { useEffect, useState } from 'react';

interface MediaAsset {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  source_url: string | null;
  storage_path: string;
  created_at: number;
  last_used_at: number;
}

function formatSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface Props {
  active: boolean;
}

export default function AssetLibrary({ active }: Props) {
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const list = await window.api.assets.list();
      setAssets(list);
    } catch (e) {
      console.error('[assets] list failed:', e);
    }
  };

  useEffect(() => {
    if (active) refresh();
  }, [active]);

  const handlePick = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      await window.api.assets.pick();
      await refresh();
    } catch (e) {
      setErr(String(e));
    }
    setBusy(false);
  };

  const handleImportUrl = async () => {
    const u = urlInput.trim();
    if (!u || busy) return;
    setBusy(true); setErr(null);
    try {
      await window.api.assets.importUrl(u);
      setUrlInput('');
      await refresh();
    } catch (e) {
      setErr(`URL 导入失败: ${String(e)}`);
    }
    setBusy(false);
  };

  const handleDelete = async (id: string, filename: string) => {
    if (!confirm(`删除「${filename}」?(本地文件也会被删除)`)) return;
    try {
      await window.api.assets.delete(id);
      await refresh();
    } catch (e) {
      setErr(`删除失败: ${String(e)}`);
    }
  };

  return (
    <div className="asset-library">
      <header className="asset-library__head">
        <div>
          <h2>素材库</h2>
          <p className="asset-library__sub">
            发布笔记时使用的图片素材。本地导入或从 URL 拉取,统一存到本地数据库。
          </p>
        </div>
        <div className="asset-library__count">
          {assets.length} 张 · 共 {formatSize(assets.reduce((s, a) => s + a.size, 0))}
        </div>
      </header>

      <section className="asset-library__toolbar">
        <button className="primary" onClick={handlePick} disabled={busy}>
          {busy ? '处理中…' : '+ 上传图片'}
        </button>
        <div className="asset-library__url-row">
          <input
            type="text"
            placeholder="或粘贴图片 URL (https://...)"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleImportUrl();
            }}
            disabled={busy}
          />
          <button onClick={handleImportUrl} disabled={busy || !urlInput.trim()}>
            从 URL 导入
          </button>
        </div>
      </section>

      {err && <div className="asset-library__error">{err}</div>}

      {assets.length === 0 ? (
        <div className="asset-library__empty">
          还没有素材。点击「+ 上传图片」从本地选, 或粘贴 URL 导入。
        </div>
      ) : (
        <div className="asset-grid">
          {assets.map((a) => (
            <div key={a.id} className="asset-card">
              <div className="asset-card__thumb">
                <img src={`xhs-asset://${a.id}`} alt={a.filename} />
                <button
                  className="asset-card__del"
                  onClick={() => handleDelete(a.id, a.filename)}
                  title="删除"
                >✕</button>
              </div>
              <div className="asset-card__info">
                <div className="asset-card__name" title={a.filename}>{a.filename}</div>
                <div className="asset-card__meta">
                  {formatSize(a.size)} · {formatTime(a.created_at)}
                  {a.source_url && <span className="asset-card__url" title={a.source_url}> · URL</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
