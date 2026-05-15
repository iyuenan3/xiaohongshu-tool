import { useEffect, useState } from 'react';

interface GoStatus {
  ok: boolean;
  baseUrl?: string | null;
  error?: string;
}

interface LoginStatusResponse {
  success?: boolean;
  data?: { is_logged_in?: boolean; username?: string };
  error?: string;
  message?: string;
}

interface PublishResponse {
  success?: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

export default function App() {
  const platform = window.electron?.process?.platform ?? 'unknown';
  const versions = window.electron?.process?.versions ?? {};

  const [goStatus, setGoStatus] = useState<GoStatus | null>(null);
  const [loginStatus, setLoginStatus] = useState<string>('未检测');
  const [busy, setBusy] = useState(false);

  // publish 表单
  const [title, setTitle] = useState('CDP attach 测试笔记');
  const [content, setContent] = useState(
    '这是从 xhs-app M1 PoC 通过 Electron CDP attach + Go MCP 发布的测试。架构验证 OK。',
  );
  const [imageUrl, setImageUrl] = useState(
    'https://cn.bing.com/th?id=OHR.MaoriRock_EN-US6499689741_UHD.jpg&w=1920',
  );
  const [tags, setTags] = useState('测试 PoC');
  const [publishResult, setPublishResult] = useState<string>('');

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

  const callLoginCheck = async () => {
    setBusy(true);
    setLoginStatus('调用中...');
    try {
      const r = (await window.api.goApi('GET', '/api/v1/login/status')) as LoginStatusResponse;
      if (r.success && r.data) {
        setLoginStatus(
          r.data.is_logged_in
            ? `✓ 已登录: ${r.data.username ?? '(用户名未读到)'}`
            : '× 未登录'
        );
      } else {
        setLoginStatus(`错误: ${r.error ?? r.message ?? JSON.stringify(r)}`);
      }
    } catch (e) {
      setLoginStatus(`异常: ${String(e)}`);
    }
    setBusy(false);
  };

  const callPublish = async () => {
    setBusy(true);
    setPublishResult('调用中...');
    try {
      const body = {
        title,
        content,
        images: [imageUrl],
        tags: tags.split(/\s+/).filter(Boolean),
      };
      const r = (await window.api.goApi('POST', '/api/v1/publish', body)) as PublishResponse;
      if (r.success) {
        setPublishResult(`✓ 发布成功: ${JSON.stringify(r.data ?? r.message ?? r)}`);
      } else {
        setPublishResult(`× 失败: ${r.error ?? r.message ?? JSON.stringify(r)}`);
      }
    } catch (e) {
      setPublishResult(`异常: ${String(e)}`);
    }
    setBusy(false);
  };

  return (
    <div className="app">
      <header className="hero">
        <div className="hero__eyebrow">M1 D8 · publish_content E2E</div>
        <h1>
          小红书<em>自运营系统</em>
        </h1>
        <p className="lede">
          关键路径已通过。本步验证: AI → IPC → Go → CDP → 真正发布到小红书。
        </p>
      </header>

      <section className="grid">
        <div className="card"><div className="card__label">Platform</div><div className="card__value">{platform}</div></div>
        <div className="card"><div className="card__label">Electron</div><div className="card__value">{versions.electron ?? '?'}</div></div>
        <div className="card"><div className="card__label">Chromium</div><div className="card__value">{versions.chrome ?? '?'}</div></div>
        <div className="card"><div className="card__label">Node</div><div className="card__value">{versions.node ?? '?'}</div></div>
      </section>

      <section className="ipc-test">
        <h2>1. Go MCP 状态 + 登录检查</h2>
        <p style={{ marginBottom: 14 }}>
          {goStatus === null && '检测中...'}
          {goStatus?.ok === true && (
            <span style={{ color: '#1f4d3a' }}>✓ Go 已就绪 · <code>{goStatus.baseUrl}</code></span>
          )}
          {goStatus?.ok === false && (
            <span style={{ color: '#8b1f15' }}>× Go 未就绪 {goStatus.error ? `(${goStatus.error})` : ''}</span>
          )}
        </p>
        <button onClick={callLoginCheck} disabled={busy || !goStatus?.ok}>
          {busy ? '查询中...' : '调用 check_login_status'}
        </button>
        <button onClick={() => window.api.openXhsWindow()} style={{ marginLeft: 8 }}>
          打开/聚焦 小红书窗口
        </button>
        <p style={{ marginTop: 14, fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}>
          → {loginStatus}
        </p>
      </section>

      <section className="ipc-test">
        <h2>2. publish_content 端到端</h2>
        <p style={{ marginBottom: 14, color: '#8a8175', fontSize: 13 }}>
          需要先在【小红书 (受 Go MCP 控制)】窗口扫码登录, 然后点发布。
          调用链: Renderer → IPC → Main → HTTP POST localhost → Go → CDP attach → 小红书 page → DOM 操作
        </p>
        <div className="form">
          <label>标题 (≤20 字)<input value={title} onChange={e => setTitle(e.target.value)} maxLength={20} /></label>
          <label>内容<textarea value={content} onChange={e => setContent(e.target.value)} rows={3} /></label>
          <label>图片 URL<input value={imageUrl} onChange={e => setImageUrl(e.target.value)} placeholder="https:// 或 本地路径" /></label>
          <label>标签 (空格分隔, 不要 #)<input value={tags} onChange={e => setTags(e.target.value)} /></label>
        </div>
        <button onClick={callPublish} disabled={busy || !goStatus?.ok} style={{ marginTop: 10 }}>
          {busy ? '发布中...' : '发布到小红书'}
        </button>
        <p style={{ marginTop: 14, fontFamily: 'JetBrains Mono, monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          → {publishResult || '(未发布)'}
        </p>
      </section>

      <footer className="footer">
        <code>xhs-app v0.1.0 · M1 D8 · publish_content E2E</code>
      </footer>
    </div>
  );
}
