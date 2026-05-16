import { useEffect, useState } from 'react';

interface MediaAsset {
  id: string;
  filename: string;
  storage_path: string;
  size: number;
}

interface Props {
  initialSelected: string[];
  onConfirm: (assets: MediaAsset[]) => void;
  onClose: () => void;
}

export default function AttachmentPicker({ initialSelected, onConfirm, onClose }: Props) {
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelected));
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const list = await window.api.assets.list();
      setAssets(list as MediaAsset[]);
    } catch (e) {
      console.error('[picker] list failed:', e);
    }
  };

  useEffect(() => { refresh(); }, []);

  const handlePick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const added = await window.api.assets.pick();
      await refresh();
      setSelected((prev) => {
        const next = new Set(prev);
        for (const a of added) next.add(a.id);
        return next;
      });
    } catch (e) {
      console.error('[picker] pick failed:', e);
    }
    setBusy(false);
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirm = () => {
    const picked = assets.filter((a) => selected.has(a.id));
    onConfirm(picked);
  };

  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="picker-modal" onClick={(e) => e.stopPropagation()}>
        <header className="picker-modal__head">
          <h3>选择图片附件</h3>
          <button className="picker-modal__close" onClick={onClose} title="关闭">✕</button>
        </header>

        <div className="picker-modal__toolbar">
          <button className="primary" onClick={handlePick} disabled={busy}>
            {busy ? '处理中…' : '+ 上传新图片'}
          </button>
          <span className="picker-modal__count">
            已选 {selected.size} 张{selected.size > 0 && ' (新选图自动勾上)'}
          </span>
        </div>

        <div className="picker-modal__body">
          {assets.length === 0 ? (
            <div className="picker-modal__empty">
              素材库为空。点击「+ 上传新图片」从本地选,或先到「素材库」tab 导入。
            </div>
          ) : (
            <div className="picker-grid">
              {assets.map((a) => {
                const on = selected.has(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    className={`picker-card ${on ? 'picker-card--on' : ''}`}
                    onClick={() => toggle(a.id)}
                    title={a.filename}
                  >
                    <img src={`xhs-asset://${a.id}`} alt={a.filename} />
                    <span className="picker-card__check">{on ? '✓' : ''}</span>
                    <span className="picker-card__name">{a.filename}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <footer className="picker-modal__foot">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={confirm} disabled={selected.size === 0}>
            添加 ({selected.size})
          </button>
        </footer>
      </div>
    </div>
  );
}
