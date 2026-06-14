import { useEffect, useRef, useState } from 'react';
import CommandPalette from './CommandPalette';
import WorkflowList from './WorkflowList';
import ConversationList, { type ConversationMeta } from './ConversationList';
import ChatPanel, { type ChatPanelHandle } from './ChatPanel';

interface Props {
  goOk: boolean;
  onOpenSettings: () => void;
  onShowHelp: () => void;
}

export default function ConsolePane({ goOk, onOpenSettings, onShowHelp }: Props) {
  const [convId, setConvId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const chatRef = useRef<ChatPanelHandle>(null);

  const refreshList = async (): Promise<ConversationMeta[]> => {
    const list = await window.api.conv.list();
    setConversations(list);
    return list;
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await refreshList();
        if (!alive) return;
        if (list.length > 0) {
          setConvId(list[0].id);
        } else {
          const id = await window.api.conv.create();
          if (!alive) return;
          setConvId(id);
          await refreshList();
        }
      } catch (e) {
        console.error('[console] init failed:', e);
      }
    })();
    return () => { alive = false; };
  }, []);

  const handleCommandPick = (prompt: string) => {
    chatRef.current?.setDraft(prompt);
  };

  const handleNew = async () => {
    try {
      const id = await window.api.conv.create();
      setConvId(id);
      await refreshList();
    } catch (e) {
      console.error('[console] new conv failed:', e);
    }
  };

  const handleSelect = (id: string) => {
    if (id !== convId) setConvId(id);
  };

  const handleDelete = async (id: string) => {
    try {
      await window.api.conv.delete(id);
      const list = await refreshList();
      if (id === convId) {
        if (list.length > 0) {
          setConvId(list[0].id);
        } else {
          const newId = await window.api.conv.create();
          setConvId(newId);
          await refreshList();
        }
      }
    } catch (e) {
      console.error('[console] delete conv failed:', e);
    }
  };

  const handleRename = async (id: string, title: string) => {
    try {
      await window.api.conv.setTitle(id, title);
      await refreshList();
    } catch (e) {
      console.error('[console] rename conv failed:', e);
    }
  };

  const currentTitle = conversations.find((c) => c.id === convId)?.title ?? null;

  return (
    <div className="console-grid">
      <aside className="console-left">
        <div className="console-left__commands">
          <CommandPalette onPick={handleCommandPick} />
        </div>
        <div className="console-left__workflows">
          <WorkflowList onShowHelp={onShowHelp} />
        </div>
        <div className="console-left__sessions">
          <ConversationList
            conversations={conversations}
            currentId={convId}
            onSelect={handleSelect}
            onNew={handleNew}
            onDelete={handleDelete}
            onRename={handleRename}
          />
        </div>
      </aside>
      <ChatPanel
        ref={chatRef}
        convId={convId}
        convTitle={currentTitle}
        goOk={goOk}
        onOpenSettings={onOpenSettings}
        onTitleSaved={refreshList}
      />
    </div>
  );
}
