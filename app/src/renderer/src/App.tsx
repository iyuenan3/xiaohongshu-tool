import { useEffect, useState } from 'react';
import ChatSidebar from './components/ChatSidebar';
import Settings from './components/Settings';

interface GoStatus {
  ok: boolean;
  baseUrl?: string | null;
  error?: string;
}

export default function App() {
  const platform = window.electron?.process?.platform ?? 'unknown';
  const versions = window.electron?.process?.versions ?? {};

  const [goStatus, setGoStatus] = useState<GoStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      const s = await window.api.goStatus();
      if (alive) setGoStatus(s);
      if (!s.ok) setTimeout(tick, 2000);
    };
    tick();
    return () => { alive = false; };
  }, []);

  return (
    <div className="layout">
      <main className="main-pane">
        <header className="hero">
          <div className="hero__eyebrow">M2 W3-W4 · AI 侧边栏 + Tool Calling</div>
          <h1>小红书<em>自运营系统</em></h1>
          <p className="lede">侧边栏 AI 通过 11 个 MCP 工具操作小红书。</p>
        </header>

        <section className="status-grid">
          <div className="status-card">
            <div className="sc-label">Platform</div>
            <div className="sc-value">{platform}</div>
          </div>
          <div className="status-card">
            <div className="sc-label">Electron</div>
            <div className="sc-value">{versions.electron ?? '?'}</div>
          </div>
          <div className="status-card">
            <div className="sc-label">Go MCP</div>
            <div className="sc-value">
              {goStatus === null ? '...' : goStatus.ok ? (
                <span style={{ color: 'var(--green)' }}>✓ ready</span>
              ) : (
                <span style={{ color: 'var(--accent)' }}>× down</span>
              )}
            </div>
          </div>
          <div className="status-card">
            <div className="sc-label">XHS 窗口</div>
            <div className="sc-value">
              <button className="link-btn" onClick={() => window.api.openXhsWindow()}>
                打开/聚焦 →
              </button>
            </div>
          </div>
        </section>

        <section className="hint-card">
          <h3>使用流程</h3>
          <ol>
            <li>点右侧侧边栏齿轮图标, 配置 AI 大模型 (火山方舟 / DeepSeek)</li>
            <li>点上方 "XHS 窗口 - 打开/聚焦", 在弹出的小红书窗口扫码登录</li>
            <li>回到侧边栏与 AI 对话, 让它帮你搜索 / 发布 / 互动</li>
            <li>敏感操作 (发布/评论/点赞/收藏) 会弹确认, 你可以审核</li>
          </ol>
        </section>

        <footer className="footer">
          <code>xhs-app v0.1.0 · M2 W3-W4 · 11 tools active</code>
        </footer>
      </main>

      <ChatSidebar goOk={goStatus?.ok === true} onOpenSettings={() => setSettingsOpen(true)} />

      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
