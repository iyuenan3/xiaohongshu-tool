import { useState } from 'react';

export interface ConversationMeta {
  id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
}

interface Props {
  conversations: ConversationMeta[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  disabled?: boolean;
}

export default function ConversationList({
  conversations, currentId, onSelect, onNew, onDelete, onRename, disabled,
}: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const beginRename = (c: ConversationMeta) => {
    setRenamingId(c.id);
    setRenameDraft(c.title ?? '');
  };

  const commitRename = (id: string) => {
    const t = renameDraft.trim();
    if (t.length > 0) onRename(id, t);
    setRenamingId(null);
  };

  return (
    <section className="conv-list">
      <div className="conv-list__header">
        <h3 className="pane-heading">对话</h3>
        <button className="conv-list__new" onClick={onNew} disabled={disabled} title="新对话">
          + 新建
        </button>
      </div>
      <div className="conv-list__body">
        {conversations.length === 0 && (
          <div className="conv-empty">暂无对话</div>
        )}
        {conversations.map((c) => {
          const isCurrent = c.id === currentId;
          const displayTitle = c.title ?? '未命名对话';
          return (
            <div
              key={c.id}
              className={`conv-item ${isCurrent ? 'conv-item--current' : ''}`}
              onClick={() => !renamingId && onSelect(c.id)}
              onDoubleClick={() => beginRename(c)}
              title={renamingId === c.id ? '回车保存 / Esc 取消' : '双击重命名'}
            >
              <span className="conv-item__caret">{isCurrent ? '▸' : ' '}</span>
              {renamingId === c.id ? (
                <input
                  className="conv-item__input"
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => commitRename(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(c.id);
                    else if (e.key === 'Escape') setRenamingId(null);
                  }}
                />
              ) : (
                <span className="conv-item__title">{displayTitle}</span>
              )}
              <button
                className="conv-item__del"
                title="删除"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`删除对话「${displayTitle}」?`)) onDelete(c.id);
                }}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
