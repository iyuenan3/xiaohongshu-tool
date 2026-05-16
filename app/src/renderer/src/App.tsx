import { useEffect, useState } from 'react';
import ConsolePane from './components/ConsolePane';
import HelpPanel from './components/HelpPanel';
import AssetLibrary from './components/AssetLibrary';
import Settings from './components/Settings';
import ActivationPage from './components/ActivationPage';

interface GoStatus {
  ok: boolean;
  baseUrl?: string | null;
  error?: string;
}

type LicenseStatus = 'unactivated' | 'active' | 'expired' | 'revoked' | 'mismatch' | 'error';

interface LicenseState {
  status: LicenseStatus;
  code?: string;
  valid_until?: number;
  message?: string;
}

type Tab = 'console' | 'xhs' | 'assets' | 'help';

export default function App() {
  const [licenseState, setLicenseState] = useState<LicenseState | null>(null);
  const [goStatus, setGoStatus] = useState<GoStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('console');

  useEffect(() => {
    let alive = true;
    window.api.license.status().then((s) => { if (alive) setLicenseState(s); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (licenseState?.status !== 'active') return;
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      const s = await window.api.goStatus();
      if (alive) setGoStatus(s);
      if (!s.ok) setTimeout(tick, 2000);
    };
    tick();
    return () => { alive = false; };
  }, [licenseState?.status]);

  if (licenseState === null) {
    return <div className="loading-screen">加载中…</div>;
  }

  if (licenseState.status !== 'active') {
    const errorMsg = renderLicenseError(licenseState);
    return (
      <ActivationPage
        initialError={errorMsg}
        onActivated={() => {
          window.api.license.status().then(setLicenseState);
        }}
      />
    );
  }

  const validDate = licenseState.valid_until
    ? new Date(licenseState.valid_until * 1000).toISOString().slice(0, 10)
    : '-';

  return (
    <div className="layout">
      <div className="tabbar">
        <button
          className={`tabbar__tab ${tab === 'console' ? 'tabbar__tab--active' : ''}`}
          onClick={() => setTab('console')}
        >
          控制台
        </button>
        <button
          className={`tabbar__tab ${tab === 'xhs' ? 'tabbar__tab--active' : ''}`}
          onClick={() => setTab('xhs')}
        >
          小红书
        </button>
        <button
          className={`tabbar__tab ${tab === 'assets' ? 'tabbar__tab--active' : ''}`}
          onClick={() => setTab('assets')}
        >
          素材库
        </button>
        <button
          className={`tabbar__tab ${tab === 'help' ? 'tabbar__tab--active' : ''}`}
          onClick={() => setTab('help')}
        >
          帮助
        </button>
        <span className="tabbar__spacer" />
        <span className="tabbar__status">
          {goStatus === null ? (
            <span style={{ color: 'var(--ink-mute)' }}>● 初始化…</span>
          ) : goStatus.ok ? (
            <span style={{ color: 'var(--green)' }}>● Go MCP ready</span>
          ) : (
            <span style={{ color: 'var(--accent)' }}>○ Go down</span>
          )}
        </span>
        <span className="tabbar__meta" title={`激活码 ${licenseState.code} / 到期 ${validDate}`}>
          v0.1.0 · {licenseState.code?.slice(-9) ?? ''} · 到 {validDate}
        </span>
        <button className="tabbar__icon" onClick={() => setSettingsOpen(true)} title="设置">⚙️</button>
      </div>

      <div className="tab-body">
        <div className={`tab-pane tab-pane--console ${tab === 'console' ? '' : 'tab-pane--hidden'}`}>
          <ConsolePane goOk={goStatus?.ok === true} onOpenSettings={() => setSettingsOpen(true)} />
        </div>

        <div
          className={`tab-pane tab-pane--xhs ${tab === 'xhs' ? '' : 'tab-pane--hidden'}`}
          dangerouslySetInnerHTML={{
            __html: '<webview src="https://www.xiaohongshu.com/explore" partition="persist:xhs" allowpopups class="xhs-webview" id="xhs-webview"></webview>',
          }}
        />

        <div className={`tab-pane tab-pane--assets ${tab === 'assets' ? '' : 'tab-pane--hidden'}`}>
          <AssetLibrary active={tab === 'assets'} />
        </div>

        <div className={`tab-pane tab-pane--help ${tab === 'help' ? '' : 'tab-pane--hidden'}`}>
          <HelpPanel />
        </div>
      </div>

      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function renderLicenseError(s: LicenseState): string | undefined {
  switch (s.status) {
    case 'unactivated':
      return undefined;
    case 'expired':
      return '激活码已过期，请重新激活';
    case 'revoked':
      return '此激活码已被吊销，请联系客服';
    case 'mismatch':
      return '此设备与激活码绑定的设备不一致，请联系客服换绑';
    case 'error':
      return s.message ?? '激活码验证出错';
    default:
      return undefined;
  }
}
