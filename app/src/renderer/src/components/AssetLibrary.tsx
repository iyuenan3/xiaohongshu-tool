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

interface AssetGroup {
  id: number;
  name: string;
  created_at: number;
  count: number;
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groups, setGroups] = useState<AssetGroup[]>([]);
  const [activeGroup, setActiveGroup] = useState<number | null>(null); // null=全部
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());

  const refresh = async () => {
    try {
      const [list, gs] = await Promise.all([
        window.api.assets.list() as unknown as Promise<MediaAsset[]>,
        window.api.assets.groups.list() as unknown as Promise<AssetGroup[]>,
      ]);
      setAssets(list);
      setGroups(gs);
      // 清理已不存在的选中项 (删除后), 避免幽灵选中
      setSelected((prev) => new Set([...prev].filter((id) => list.some((a) => a.id === id))));
      // 当前分组仍存在则刷新其成员; 不存在 (被删) 则回到全部
      if (activeGroup != null) {
        if (gs.some((g) => g.id === activeGroup)) {
          const members = await window.api.assets.groups.members(activeGroup) as unknown as MediaAsset[];
          setMemberIds(new Set(members.map((a) => a.id)));
        } else {
          setActiveGroup(null);
          setMemberIds(new Set());
        }
      }
    } catch (e) {
      console.error('[assets] list failed:', e);
    }
  };

  useEffect(() => {
    if (active) refresh();
  }, [active]);

  // 切换分组过滤: 拉取该组成员 id
  const selectGroup = async (id: number | null) => {
    setActiveGroup(id);
    setSelected(new Set());
    if (id == null) { setMemberIds(new Set()); return; }
    try {
      const members = await window.api.assets.groups.members(id) as unknown as MediaAsset[];
      setMemberIds(new Set(members.map((a) => a.id)));
    } catch (e) {
      setErr(`加载分组失败: ${String(e)}`);
    }
  };

  // Electron 渲染进程不支持 window.prompt (抛错), 用应用内受控模态取名 (review #5)
  const [groupDialog, setGroupDialog] = useState<{ mode: 'create' | 'rename'; id?: number; value: string } | null>(null);

  const handleCreateGroup = () => setGroupDialog({ mode: 'create', value: '' });
  const handleRenameGroup = (g: AssetGroup) => setGroupDialog({ mode: 'rename', id: g.id, value: g.name });

  const submitGroupDialog = async () => {
    if (!groupDialog) return;
    const name = groupDialog.value.trim();
    if (!name) { setGroupDialog(null); return; }
    try {
      if (groupDialog.mode === 'create') {
        const g = await window.api.assets.groups.create(name) as unknown as AssetGroup;
        // 若已有选中素材, 顺手加入新组
        if (selected.size > 0) await window.api.assets.groups.add(g.id, [...selected]);
      } else if (groupDialog.id != null) {
        await window.api.assets.groups.rename(groupDialog.id, name);
      }
      setGroupDialog(null);
      await refresh();
    } catch (e) {
      setErr(`分组操作失败: ${String(e)}`);
      setGroupDialog(null);
    }
  };

  const handleDeleteGroup = async (g: AssetGroup) => {
    if (!confirm(`删除分组「${g.name}」?(只删分组, 素材本身保留)`)) return;
    try {
      await window.api.assets.groups.delete(g.id);
      if (activeGroup === g.id) { setActiveGroup(null); setMemberIds(new Set()); }
      await refresh();
    } catch (e) {
      setErr(`删除分组失败: ${String(e)}`);
    }
  };

  const handleAddSelectedToGroup = async (groupId: number) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    try {
      await window.api.assets.groups.add(groupId, ids);
      await refresh();
    } catch (e) {
      setErr(`加入分组失败: ${String(e)}`);
    }
  };

  const handleRemoveSelectedFromGroup = async () => {
    if (activeGroup == null) return;
    const ids = [...selected];
    if (ids.length === 0) return;
    try {
      await window.api.assets.groups.remove(activeGroup, ids);
      setSelected(new Set());
      await refresh();
    } catch (e) {
      setErr(`移出分组失败: ${String(e)}`);
    }
  };

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
    if (busy) return;
    if (!confirm(`删除「${filename}」?(本地文件也会被删除)`)) return;
    try {
      await window.api.assets.delete(id);
      await refresh();
    } catch (e) {
      setErr(`删除失败: ${String(e)}`);
    }
  };

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 当前视图: 全部 或 某分组成员
  const displayed = activeGroup == null ? assets : assets.filter((a) => memberIds.has(a.id));

  const allSelected = displayed.length > 0 && displayed.every((a) => selected.has(a.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(displayed.map((a) => a.id)));

  const handleDeleteSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0 || busy) return;
    if (!confirm(`删除选中的 ${ids.length} 张素材?(本地文件也会被删除)`)) return;
    setBusy(true); setErr(null);
    let fails = 0;
    for (const id of ids) {
      try {
        await window.api.assets.delete(id);
      } catch (e) {
        fails++;
        console.error('[assets] batch delete failed:', id, e);
      }
    }
    setSelected(new Set());
    await refresh();
    setBusy(false);
    if (fails > 0) setErr(`批量删除: ${ids.length - fails} 成功, ${fails} 失败`);
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
      {groupDialog && (
        <div className="asset-group-modal" onClick={() => setGroupDialog(null)}>
          <div className="asset-group-modal__box" onClick={(e) => e.stopPropagation()}>
            <div className="asset-group-modal__title">
              {groupDialog.mode === 'create' ? '新建分组' : '重命名分组'}
            </div>
            <input
              autoFocus
              className="asset-group-modal__input"
              value={groupDialog.value}
              placeholder="分组名称"
              onChange={(e) => setGroupDialog({ ...groupDialog, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitGroupDialog();
                if (e.key === 'Escape') setGroupDialog(null);
              }}
            />
            {groupDialog.mode === 'create' && selected.size > 0 && (
              <div className="asset-group-modal__hint">将把已选 {selected.size} 张素材加入该组</div>
            )}
            <div className="asset-group-modal__actions">
              <button onClick={() => setGroupDialog(null)}>取消</button>
              <button className="primary" onClick={submitGroupDialog} disabled={!groupDialog.value.trim()}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}
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

      {(groups.length > 0 || assets.length > 0) && (
        <section className="asset-library__groups">
          <button
            className={`asset-group-chip${activeGroup == null ? ' asset-group-chip--active' : ''}`}
            onClick={() => selectGroup(null)}
            disabled={busy}
          >
            全部 ({assets.length})
          </button>
          {groups.map((g) => (
            <span
              key={g.id}
              className={`asset-group-chip${activeGroup === g.id ? ' asset-group-chip--active' : ''}`}
            >
              <button className="asset-group-chip__name" onClick={() => selectGroup(g.id)} disabled={busy}>
                {g.name} ({g.count})
              </button>
              {activeGroup === g.id && (
                <>
                  <button className="asset-group-chip__op" title="重命名" onClick={() => handleRenameGroup(g)} disabled={busy}>✎</button>
                  <button className="asset-group-chip__op" title="删除分组" onClick={() => handleDeleteGroup(g)} disabled={busy}>🗑</button>
                </>
              )}
            </span>
          ))}
          <button className="asset-group-chip asset-group-chip--add" onClick={handleCreateGroup} disabled={busy}>
            + 新建分组
          </button>
        </section>
      )}

      {displayed.length > 0 && (
        <div className="asset-library__select">
          <label className="asset-library__selall">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={busy} />
            全选{activeGroup != null ? '本组' : ''}
          </label>
          {selected.size > 0 && <span className="asset-library__selcount">已选 {selected.size} 张</span>}
          {selected.size > 0 && groups.length > 0 && (
            <select
              className="asset-library__addgroup"
              value=""
              disabled={busy}
              onChange={(e) => { const gid = Number(e.target.value); if (gid) handleAddSelectedToGroup(gid); e.target.value = ''; }}
            >
              <option value="">＋ 加入分组…</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
          {activeGroup != null && selected.size > 0 && (
            <button className="asset-library__delsel" onClick={handleRemoveSelectedFromGroup} disabled={busy}>
              移出本组 ({selected.size})
            </button>
          )}
          <button
            className="asset-library__delsel"
            onClick={handleDeleteSelected}
            disabled={busy || selected.size === 0}
          >
            🗑 删除选中{selected.size ? ` (${selected.size})` : ''}
          </button>
        </div>
      )}

      {err && <div className="asset-library__error">{err}</div>}

      {assets.length === 0 ? (
        <div className="asset-library__empty">
          还没有素材。点击「+ 上传图片」从本地选, 或粘贴 URL 导入。
        </div>
      ) : displayed.length === 0 ? (
        <div className="asset-library__empty">
          该分组还没有素材。切到「全部」勾选素材后, 用「＋ 加入分组」把它们加进来。
        </div>
      ) : (
        <div className="asset-grid">
          {displayed.map((a) => {
            const tags = parseTags(a.tags);
            return (
              <div key={a.id} className={`asset-card${selected.has(a.id) ? ' asset-card--selected' : ''}`}>
                <div className="asset-card__thumb">
                  <img src={`xhs-asset://${a.id}`} alt={a.filename} />
                  <input
                    type="checkbox"
                    className="asset-card__check"
                    checked={selected.has(a.id)}
                    onChange={() => toggleSelect(a.id)}
                    disabled={busy}
                    title="选择 (批量删除)"
                  />
                  <button
                    className="asset-card__del"
                    onClick={() => handleDelete(a.id, a.filename)}
                    disabled={busy}
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
