import { forwardRef, useEffect, useImperativeHandle, useRef, useState, memo } from 'react';
import { isBYOKConfigured, loadBYOK } from '../ai/byok';
import { runAgent, type ChatMessage, type AgentEvent } from '../ai/agent';
import { getHttpBinding } from '../ai/tools';
import ConfirmDialog, { type ConfirmDialogHandle } from './ConfirmDialog';
import AttachmentPicker from './AttachmentPicker';

interface AttachedAsset {
  id: string;
  filename: string;
  storage_path: string;
}

export interface ChatPanelHandle {
  setDraft: (text: string) => void;
}

interface Props {
  convId: string | null;
  convTitle: string | null;
  goOk: boolean;
  onOpenSettings: () => void;
  onTitleSaved: () => void;
}

interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  toolCalls?: { name: string; args: string; result?: string; error?: string }[];
}

const ChatPanel = forwardRef<ChatPanelHandle, Props>(function ChatPanel(
  { convId, convTitle, goOk, onOpenSettings, onTitleSaved },
  ref,
) {
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [display, setDisplay] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'thinking' | 'calling' | 'replying'>('idle');
  const [currentTool, setCurrentTool] = useState<string>('');
  const [byokOk, setByokOk] = useState(isBYOKConfigured());
  const [attachments, setAttachments] = useState<AttachedAsset[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const confirmRef = useRef<ConfirmDialogHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const currentAssistantId = useRef<string>('');

  useImperativeHandle(ref, () => ({
    setDraft(text: string) {
      setInput(text);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        const i = text.indexOf('___');
        if (i >= 0) el.setSelectionRange(i, i + 3);
        else el.setSelectionRange(text.length, text.length);
      });
    },
  }));

  useEffect(() => {
    setByokOk(isBYOKConfigured());
  });

  // 加载 / 切换会话 → 恢复历史
  useEffect(() => {
    if (!convId) {
      setHistory([]);
      setDisplay([]);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const { messages } = await window.api.conv.get(convId);
        if (!alive) return;
        const restored: ChatMessage[] = messages
          .filter((m) => m.role !== 'system')
          .map((m) => {
            if (m.role === 'assistant') {
              return {
                role: 'assistant',
                content: m.content ?? '',
                tool_calls: m.tool_calls as ChatMessage extends { role: 'assistant' } ? unknown : never,
              } as ChatMessage;
            }
            if (m.role === 'tool') {
              return { role: 'tool', tool_call_id: m.tool_call_id ?? '', content: m.content ?? '' };
            }
            return { role: 'user', content: m.content ?? '' };
          });
        setHistory(restored);
        setDisplay(restored.map(toDisplay));
      } catch (e) {
        console.error('[chat] load conv failed:', e);
      }
    })();
    return () => { alive = false; };
  }, [convId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [display, phase, currentTool]);

  const callTool = async (name: string, args: unknown): Promise<unknown> => {
    // 本地处理: search_local_assets 不走 Go, 直接查 SQLite
    if (name === 'search_local_assets') {
      const a = (args ?? {}) as { query?: string; limit?: number };
      const list = await window.api.assets.search(a.query ?? '', a.limit ?? 10);
      return list.map((x) => ({
        id: x.id,
        filename: x.filename,
        tags: safeParseTags(x.tags),
        description: x.description,
        path: x.storage_path,
        analyzed: x.analyzed === 1,
      }));
    }
    const binding = getHttpBinding(name);
    if (!binding) throw new Error(`unknown tool: ${name}`);
    return window.api.goApi(binding.method, binding.path, args);
  };

  const handleEvent = (e: AgentEvent) => {
    if (e.type === 'text_delta' && e.text) {
      setPhase('replying');
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
      setPhase('calling');
      setCurrentTool(e.toolName);
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
      setPhase('thinking');
      setCurrentTool('');
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
    if (!convId) return;

    const userText = input.trim();
    const sentAttachments = attachments;
    setInput('');
    setAttachments([]);
    setBusy(true);
    setPhase('thinking');
    setCurrentTool('');

    // 附件: 同时构造路径文本 (给 publish_content 用) + base64 data URL (给 vision 模型看)
    let promptForLLM = userText;
    const imageDataUrls: string[] = [];
    if (sentAttachments.length > 0) {
      const paths: string[] = [];
      for (const a of sentAttachments) {
        try {
          const p = await window.api.assets.getPath(a.id);
          if (p) paths.push(p);
          const dataUrl = await fetchAsDataUrl(`xhs-asset://${a.id}`);
          if (dataUrl) imageDataUrls.push(dataUrl);
        } catch (e) {
          console.error('[chat] attachment read failed:', e);
        }
      }
      if (paths.length > 0) {
        promptForLLM += '\n\n[附件: 用户已上传 ' + paths.length + ' 张图片 (本消息内已附图供你查看)。如本轮要调用 publish_content, 请把以下绝对路径作为 images 参数:\n'
          + paths.map((p) => '- ' + p).join('\n') + ']';
        await window.api.assets.touchUsed(sentAttachments.map((a) => a.id));
      }
    }

    const userMsgId = `user-${Date.now()}`;
    currentAssistantId.current = `asst-${Date.now()}`;
    // 显示给用户的气泡仍是原文 + 附件 chip 摘要
    const displayText = sentAttachments.length > 0
      ? `${userText}\n\n📎 ${sentAttachments.map((a) => a.filename).join(' · ')}`
      : userText;
    setDisplay((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', text: displayText },
    ]);

    const prevLen = history.length;

    try {
      const newHistory = await runAgent({
        cfg,
        history,
        userInput: promptForLLM,
        userImageDataUrls: imageDataUrls,
        onEvent: handleEvent,
        onToolCall: callTool,
        onConfirm: async (info) => confirmRef.current?.show(info) ?? false,
      });
      setHistory(newHistory);
      const newMsgs = newHistory.slice(prevLen);
      if (newMsgs.length > 0) {
        try {
          await window.api.conv.saveMessages(
            convId,
            newMsgs.map((m) => ({
              role: m.role,
              content: m.role === 'tool'
                ? m.content
                : (m as { content: string }).content,
              tool_calls: m.role === 'assistant' ? m.tool_calls : undefined,
              tool_call_id: m.role === 'tool' ? m.tool_call_id : undefined,
            })),
          );
          if (prevLen === 0) {
            const titleSrc = userText.trim() || (sentAttachments[0]?.filename ?? '新对话');
            await window.api.conv.setTitle(convId, titleSrc.slice(0, 12));
            onTitleSaved();
          }
        } catch (e) {
          console.error('[chat] saveMessages failed:', e);
        }
      }
    } catch (e) {
      setDisplay((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, role: 'tool', text: `异常: ${String(e)}` },
      ]);
    }
    setBusy(false);
    setPhase('idle');
    setCurrentTool('');
  };

  const clearCurrent = async () => {
    if (busy || !convId) return;
    if (!confirm('清空当前对话内的所有消息?')) return;
    try {
      await window.api.conv.clearMessages(convId);
      setHistory([]);
      setDisplay([]);
      onTitleSaved();
    } catch (e) {
      console.error('[chat] clearMessages failed:', e);
    }
  };

  const displayTitle = convTitle ?? '新对话';

  return (
    <section className="chat-panel">
      <header className="chat-panel__header">
        <div className="chat-panel__title" title={displayTitle}>{displayTitle}</div>
        <button
          className="chat-panel__action"
          onClick={clearCurrent}
          disabled={busy || !convId || display.length === 0}
          title="清空此对话消息"
        >
          清空
        </button>
      </header>

      <div ref={scrollRef} className="chat-panel__messages">
        {display.length === 0 && (
          <div className="chat-empty">
            {!byokOk && (
              <p className="chat-empty__hint">
                ⚠️ 请先点右上 <button className="link-btn" onClick={onOpenSettings}>⚙️</button> 配置 AI 大模型 (BYOK)
              </p>
            )}
            {byokOk && !goOk && <p className="chat-empty__hint">⚠️ Go 服务未就绪…</p>}
            {byokOk && goOk && (
              <>
                <p className="chat-empty__hint">👋 告诉我你想做什么</p>
                <ul className="chat-empty__samples">
                  <li>搜一下"露营"相关的笔记</li>
                  <li>看看首页推荐前 3 篇</li>
                  <li>查我自己主页 (我是谁、关注、粉丝)</li>
                </ul>
                <p className="chat-empty__hint chat-empty__hint--mute">
                  或者点左上的「常用命令」预填指令。
                </p>
              </>
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
                  <ToolCallItem key={i} tc={tc} />
                ))}
              </div>
            )}
            {m.role === 'tool' && <div className="msg-system">{m.text}</div>}
          </div>
        ))}

        {(phase === 'thinking' || phase === 'calling') && (
          <div className="thinking-indicator">
            <span className="thinking-indicator__dots" aria-hidden>
              <i /><i /><i />
            </span>
            <span className="thinking-indicator__text">
              {phase === 'thinking' ? 'AI 正在思考' : `正在调用 ${currentTool}`}
            </span>
          </div>
        )}
      </div>

      <div className="chat-panel__input">
        {attachments.length > 0 && (
          <div className="chat-attachments">
            {attachments.map((a) => (
              <span key={a.id} className="chat-attachment" title={a.filename}>
                <img src={`xhs-asset://${a.id}`} alt="" />
                <span className="chat-attachment__name">{a.filename}</span>
                <button
                  className="chat-attachment__del"
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                  title="移除"
                >✕</button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={byokOk ? '与 AI 对话... (⌘/Ctrl + Enter 发送)' : '请先配置 BYOK API Key'}
          disabled={!byokOk || busy}
          rows={3}
        />
        <div className="chat-panel__toolbar">
          <button
            className="chat-panel__attach"
            onClick={() => setPickerOpen(true)}
            disabled={busy}
            title="添加图片附件"
          >
            📎 图片
          </button>
          <button
            className="chat-panel__send primary"
            onClick={submit}
            disabled={(!input.trim() && attachments.length === 0) || busy || !byokOk}
          >
            {busy ? '思考中...' : '发送 ⌘↩'}
          </button>
        </div>
      </div>

      {pickerOpen && (
        <AttachmentPicker
          initialSelected={attachments.map((a) => a.id)}
          onClose={() => setPickerOpen(false)}
          onConfirm={(picked) => {
            setAttachments(picked.map((p) => ({ id: p.id, filename: p.filename, storage_path: p.storage_path })));
            setPickerOpen(false);
          }}
        />
      )}

      <ConfirmDialog ref={confirmRef} />
    </section>
  );
});

export default ChatPanel;

interface ToolCallView {
  name: string;
  args: string;
  result?: string;
  error?: string;
}

const ToolCallItem = memo(function ToolCallItem({ tc }: { tc: ToolCallView }) {
  const [open, setOpen] = useState(!!tc.error);
  const hasArgs = tc.args && tc.args.trim() !== '' && tc.args.trim() !== '{}';
  const status: 'ok' | 'err' | 'pending' = tc.error ? 'err' : tc.result ? 'ok' : 'pending';
  const statusGlyph = status === 'ok' ? '✓' : status === 'err' ? '✗' : '…';

  return (
    <div className={`tool-call tool-call--${status}`}>
      <button
        type="button"
        className="tool-call__head"
        onClick={() => setOpen((o) => !o)}
        title={open ? '收起' : '展开详情'}
      >
        <span className="tool-call__icon">🔧</span>
        <span className="tool-call__name">{tc.name}</span>
        <span className={`tool-call__status tool-call__status--${status}`}>{statusGlyph}</span>
        <span className="tool-call__chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-call__body">
          {hasArgs && (
            <div className="tool-call__row">
              <span className="tool-call__label">参数</span>
              <pre className="tool-call__code">{prettyJson(tc.args)}</pre>
            </div>
          )}
          {tc.error && (
            <div className="tool-call__row">
              <span className="tool-call__label">错误</span>
              <div className="tool-call__err-msg">{tc.error}</div>
            </div>
          )}
          {tc.result && (
            <div className="tool-call__row">
              <span className="tool-call__label">原始结果</span>
              <pre className="tool-call__code">{prettyJson(tc.result)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

function prettyJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); }
  catch { return s; }
}

function safeParseTags(s: string | null | undefined): string[] {
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

function toDisplay(m: ChatMessage): DisplayMessage {
  if (m.role === 'user') {
    return { id: `u-${Math.random().toString(36).slice(2, 9)}`, role: 'user', text: m.content };
  }
  if (m.role === 'assistant') {
    const tcs = m.tool_calls?.map((tc: any) => ({
      name: tc.function?.name ?? '?',
      args: tc.function?.arguments ?? '{}',
    }));
    return {
      id: `a-${Math.random().toString(36).slice(2, 9)}`,
      role: 'assistant',
      text: m.content,
      toolCalls: tcs,
    };
  }
  return { id: `t-${Math.random().toString(36).slice(2, 9)}`, role: 'tool', text: m.content };
}
