import { useEffect, useState } from 'react';

interface GoStatus {
  ok: boolean;
  baseUrl?: string | null;
  error?: string;
}

interface LoginStatusResponse {
  success?: boolean;
  data?: { is_logged_in?: boolean; account?: { username?: string } };
  error?: string;
  message?: string;
}

export default function App() {
  const platform = window.electron?.process?.platform ?? 'unknown';
  const versions = window.electron?.process?.versions ?? {};

  const [goStatus, setGoStatus] = useState<GoStatus | null>(null);
  const [loginStatus, setLoginStatus] = useState<string>('未检测');
  const [busy, setBusy] = useState(false);

  // 每 2 秒轮询 Go 状态, 直到 ready
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
            ? `✓ 已登录: ${r.data.account?.username ?? '(未知用户名)'}`
            : '× 未登录 (请先在浏览器内打开 xiaohongshu.com 扫码)'
        );
      } else {
        setLoginStatus(`错误: ${r.error ?? r.message ?? JSON.stringify(r)}`);
      }
    } catch (e) {
      setLoginStatus(`异常: ${String(e)}`);
    }
    setBusy(false);
  };

  const navigateToXhs = () => {
    // 让 Electron 主进程在主窗口打开小红书
    window.location.href = 'https://www.xiaohongshu.com';
  };

  return (
    <div className="app">
      <header className="hero">
        <div className="hero__eyebrow">M1 D5-D7 · CDP 联调</div>
        <h1>
          小红书<em>自运营系统</em>
        </h1>
        <p className="lede">
          Electron Chromium 通过 CDP attach 给 Go MCP 服务使用。
        </p>
      </header>

      <section className="grid">
        <div className="card">
          <div className="card__label">Platform</div>
          <div className="card__value">{platform}</div>
        </div>
        <div className="card">
          <div className="card__label">Electron</div>
          <div className="card__value">{versions.electron ?? '?'}</div>
        </div>
        <div className="card">
          <div className="card__label">Chromium</div>
          <div className="card__value">{versions.chrome ?? '?'}</div>
        </div>
        <div className="card">
          <div className="card__label">Node</div>
          <div className="card__value">{versions.node ?? '?'}</div>
        </div>
      </section>

      <section className="ipc-test">
        <h2>Go MCP 子进程状态</h2>
        <p style={{ marginBottom: 14 }}>
          {goStatus === null && '检测中...'}
          {goStatus?.ok === true && (
            <span style={{ color: '#1f4d3a' }}>
              ✓ Go 已就绪 · <code>{goStatus.baseUrl}</code>
            </span>
          )}
          {goStatus?.ok === false && (
            <span style={{ color: '#8b1f15' }}>
              × Go 未就绪 {goStatus.error ? `(${goStatus.error})` : ''}
            </span>
          )}
        </p>
        <button onClick={callLoginCheck} disabled={busy || !goStatus?.ok}>
          {busy ? '查询中...' : '调用 Go: check_login_status'}
        </button>
        <button onClick={navigateToXhs}>跳转到 xiaohongshu.com</button>
        <p style={{ marginTop: 14, fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}>
          → {loginStatus}
        </p>
      </section>

      <footer className="footer">
        <code>xhs-app v0.1.0 · M1 D5-D7 联调验证</code>
      </footer>
    </div>
  );
}
