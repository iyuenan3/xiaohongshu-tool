import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);
  const platform = window.electron?.process?.platform ?? 'unknown';
  const versions = window.electron?.process?.versions ?? {};

  return (
    <div className="app">
      <header className="hero">
        <div className="hero__eyebrow">M1 PoC · Commit 0</div>
        <h1>
          小红书<em>自运营系统</em>
        </h1>
        <p className="lede">
          Electron 脚手架启动成功。下一步：Go 子进程 + CDP 联调。
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
        <h2>IPC contextBridge 自检</h2>
        <button onClick={() => setCount(c => c + 1)}>
          renderer 计数: {count}
        </button>
        <button
          onClick={async () => {
            const r = await window.api?.ping?.();
            alert(r ? `主进程回应: ${r}` : 'api.ping 不可用');
          }}
        >
          调用 main 进程 app:ping
        </button>
      </section>

      <footer className="footer">
        <code>xhs-app v0.1.0 · 配套 SPEC v0.1 · 路线 A</code>
      </footer>
    </div>
  );
}
