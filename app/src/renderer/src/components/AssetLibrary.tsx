import { useEffect, useState } from 'react';
import { loadActiveLLM } from '../ai/byok';
import { analyzeImage } from '../ai/assetAnalyzer';

interface MediaAsset {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  source_url: string | null;
  storage_path: string;
  created_at: number;
  last_used_at: number;
  tags: string;
  description: string | null;
  analyzed: number;
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

function parseTags(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

async function fetchAsDataUrl(url: string): Promise<string | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const blob = await r.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch { return null; }
}

interface Props {
  active: boolean;
}

export default function AssetLibrary({ active }: Props) {
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const list = await window.api.assets.list() as unknown as MediaAsset[];
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

  const handleAnalyze = async () => {
    if (busy) return;
    const cfg = await loadActiveLLM();
    if (!cfg) { setErr('AI 未就绪. 请先激活软件; 或在设置中解锁开发者模式配置 BYOK (vision 模型如火山方舟 doubao)'); return; }
    const pending = assets.filter((a) => a.analyzed !== 1);
    if (pending.length === 0) return;

    setBusy(true); setErr(null);
    setAnalyzeProgress({ done: 0, total: pending.length });
    let fails = 0;
    for (let i = 0; i < pending.length; i++) {
      const a = pending[i];
      try {
        const dataUrl = await fetchAsDataUrl(`xhs-asset://${a.id}`);
        if (!dataUrl) throw new Error('读取失败');
        const { tags, description } = await analyzeImage(cfg, dataUrl);
        await window.api.assets.setTags(a.id, tags, description);
      } catch (e) {
        fails++;
        console.error(`[assets] analyze failed for ${a.filename}:`, e);
      }
      setAnalyzeProgress({ done: i + 1, total: pending.length });
      await refresh();
    }
    setAnalyzeProgress(null);
    setBusy(false);
    if (fails > 0) setErr(`完成: ${pending.length - fails} 成功, ${fails} 失败 (可能是模型不支持 vision)`);
  };

  const unanalyzedCount = assets.filter((a) => a.analyzed !== 1).length;
  // v0.6 D6: 兼容旧 "byok" 命名 (此处含义实际是"LLM 已就绪"), 异步查
  const [byokOk, setByokOk] = useState(false);
  useEffect(() => {
    let alive = true;
    loadActiveLLM().then((c) => { if (alive) setByokOk(c !== null); });
    const unsub = window.api.license.onChanged?.(() => {
      loadActiveLLM().then((c) => { if (alive) setByokOk(c !== null); });
    });
    return () => { alive = false; unsub?.(); };
  }, []);

  return (
    <div className="asset-library">
      <header className="asset-library__head">
        <div>
          <h2>素材库</h2>
          <p className="asset-library__sub">
            发布笔记时使用的图片素材。上传时自动压缩 (JPEG q75) + 重命名 picture-YYYYMMDD-HHmmss-N.jpg。
            AI 通过 tag 检索, 上传后点「补分析」让 LLM 给图片打 tag。
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
            onKeyDown={(e) => { if (e.key === 'Enter') handleImportUrl(); }}
            disabled={busy}
          />
          <button onClick={handleImportUrl} disabled={busy || !urlInput.trim()}>
            从 URL 导入
          </button>
        </div>
        {unanalyzedCount > 0 && (
          <button
            onClick={handleAnalyze}
            disabled={busy || !byokOk}
            title={byokOk ? '逐张调用 BYOK vision 模型生成 tag + 描述' : '请先配置 BYOK'}
            className="asset-library__analyze"
          >
            {analyzeProgress
              ? `分析中 ${analyzeProgress.done}/${analyzeProgress.total}…`
              : `🪄 补分析 ${unanalyzedCount} 张`}
          </button>
        )}
      </section>

      {err && <div className="asset-library__error">{err}</div>}

      {assets.length === 0 ? (
        <div className="asset-library__empty">
          还没有素材。点击「+ 上传图片」从本地选, 或粘贴 URL 导入。
        </div>
      ) : (
        <div className="asset-grid">
          {assets.map((a) => {
            const tags = parseTags(a.tags);
            return (
              <div key={a.id} className="asset-card">
                <div className="asset-card__thumb">
                  <img src={`xhs-asset://${a.id}`} alt={a.filename} />
                  <button
                    className="asset-card__del"
                    onClick={() => handleDelete(a.id, a.filename)}
                    title="删除"
                  >✕</button>
                  {a.analyzed !== 1 && <span className="asset-card__badge" title="尚未分析 / 没有 tag">○</span>}
                </div>
                <div className="asset-card__info">
                  <div className="asset-card__name" title={a.filename}>{a.filename}</div>
                  <div className="asset-card__meta">
                    {formatSize(a.size)} · {formatTime(a.created_at)}
                    {a.source_url && <span className="asset-card__url" title={a.source_url}> · URL</span>}
                  </div>
                  {tags.length > 0 && (
                    <div className="asset-card__tags" title={a.description ?? ''}>
                      {tags.map((t) => <span key={t} className="asset-tag">{t}</span>)}
                    </div>
                  )}
                  {a.description && (
                    <div className="asset-card__desc" title={a.description}>{a.description}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
