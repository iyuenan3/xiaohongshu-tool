import { useEffect, useRef, useState } from 'react';
import { isBYOKConfigured, loadBYOK } from '../ai/byok';
import { runAgent, type ChatMessage, type AgentEvent } from '../ai/agent';
import { getHttpBinding } from '../ai/tools';
import ConfirmDialog, { type ConfirmDialogHandle } from './ConfirmDialog';

interface Props {
  goOk: boolean;
  onOpenSettings: () => void;
}

interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  toolCalls?: { name: string; args: string; result?: string; error?: string }[];
}

export default function ChatSidebar({ goOk, onOpenSettings }: Props) {
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [display, setDisplay] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [byokOk, setByokOk] = useState(isBYOKConfigured());
  const confirmRef = useRef<ConfirmDialogHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentAssistantId = useRef<string>('');

  useEffect(() => {
    setByokOk(isBYOKConfigured());
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [display]);

  const callTool = async (name: string, args: unknown): Promise<unknown> => {
    const binding = getHttpBinding(name);
    if (!binding) throw new Error(`unknown tool: ${name}`);
    return window.api.goApi(binding.method, binding.path, args);
  };

  const handleEvent = (e: AgentEvent) => {
    if (e.type === 'text_delta' && e.text) {
      setDisplay((prev) => {
        const idx = prev.findIndex((m) => m.id === currentAssistantId.current);
        if (idx === -1) {
          return [
            ...prev,
            { id: currentAssistantId.current, role: 'assistant', text: e.text!, toolCalls: [] },
          ];
        }
        const next = [...prev];
        next[idx] = { ...next[idx], text: next[idx].text + e.text! };
        return next;
      });
    } else if (e.type === 'tool_call_start' && e.toolName) {
      setDisplay((prev) => {
        const idx = prev.findIndex((m) => m.id === currentAssistantId.current);
        const call = { name: e.toolName!, args: e.toolArgs ?? '{}' };
        if (idx === -1) {
          return [...prev, { id: currentAssistantId.current, role: 'assistant', text: '', toolCalls: [call] }];
        }
        const next = [...prev];
        next[idx] = { ...next[idx], toolCalls: [...(next[idx].toolCalls ?? []), call] };
        return next;
      });
    } else if (e.type === 'tool_result') {
      setDisplay((prev) => {
        const idx = prev.findIndex((m) => m.id === currentAssistantId.current);
        if (idx === -1) return prev;
        const next = [...prev];
        const calls = [...(next[idx].toolCalls ?? [])];
        const last = calls[calls.length - 1];
        if (last) {
          if (e.toolError) last.error = e.toolError;
          else last.result = JSON.stringify(e.toolResult).slice(0, 500);
        }
        next[idx] = { ...next[idx], toolCalls: calls };
        return next;
      });
    } else if (e.type === 'error' && e.error) {
      setDisplay((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, role: 'tool', text: `错误: ${e.error}` },
      ]);
    }
  };

  const submit = async () => {
    if (!input.trim() || busy) return;
    if (!byokOk) {
      onOpenSettings();
      return;
    }
    const cfg = loadBYOK();
    if (!cfg) return;

    const userText = input.trim();
    setInput('');
    setBusy(true);

    const userMsgId = `user-${Date.now()}`;
    currentAssistantId.current = `asst-${Date.now()}`;
    setDisplay((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', text: userText },
    ]);

    try {
      const newHistory = await runAgent({
        cfg,
        history,
        userInput: userText,
        onEvent: handleEvent,
        onToolCall: callTool,
        onConfirm: async (info) => confirmRef.current?.show(info) ?? false,
      });
      setHistory(newHistory);
    } catch (e) {
      setDisplay((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, role: 'tool', text: `异常: ${String(e)}` },
      ]);
    }
    setBusy(false);
  };

  return (
    <aside className="chat-sidebar">
      <header className="chat-header">
        <div className="chat-title">AI 助手</div>
        <button className="icon-btn" title="设置" onClick={onOpenSettings}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
      </header>

      <div ref={scrollRef} className="chat-messages">
        {display.length === 0 && (
          <div className="chat-empty">
            <p style={{ fontSize: 14, color: 'var(--ink-soft)' }}>
              {!byokOk && '⚠️ 请先点右上角配置 AI 大模型 (BYOK)'}
              {byokOk && !goOk && '⚠️ Go 服务未就绪'}
              {byokOk && goOk && '与 AI 对话, 它会帮你操作小红书。'}
            </p>
            {byokOk && goOk && (
              <ul style={{ fontSize: 12, color: 'var(--ink-mute)', marginTop: 12, paddingLeft: 18 }}>
                <li>搜索一下"咖啡"相关的笔记</li>
                <li>看看首页推荐前 5 篇</li>
                <li>帮我写一篇关于秋季穿搭的笔记 (但暂不发布)</li>
              </ul>
            )}
          </div>
        )}

        {display.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            {m.role === 'user' && <div className="msg-bubble">{m.text}</div>}
            {m.role === 'assistant' && (
              <div className="msg-asst">
                {m.text && <div className="msg-bubble">{m.text}</div>}
                {m.toolCalls?.map((tc, i) => (
                  <div key={i} className="tool-call">
                    <div className="tc-name">{tc.name}</div>
                    <pre className="tc-args">{tc.args}</pre>
                    {tc.error && <div className="tc-error">✗ {tc.error}</div>}
                    {tc.result && <pre className="tc-result">{tc.result}</pre>}
                  </div>
                ))}
              </div>
            )}
            {m.role === 'tool' && <div className="msg-system">{m.text}</div>}
          </div>
        ))}
      </div>

      <div className="chat-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={byokOk ? '与 AI 对话... (Cmd/Ctrl + Enter 发送)' : '请先配置 BYOK API Key'}
          disabled={!byokOk || busy}
          rows={3}
        />
        <button className="primary" onClick={submit} disabled={!input.trim() || busy || !byokOk}>
          {busy ? '思考中...' : '发送'}
        </button>
      </div>

      <ConfirmDialog ref={confirmRef} />
    </aside>
  );
}
