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

type LicenseStatus = 'unactivated' | 'active' | 'suspended' | 'expired' | 'revoked' | 'mismatch' | 'error';

interface LlmConfig {
  base_url: string;
  api_key: string;
  model: string;
}

interface LicenseState {
  status: LicenseStatus;
  code?: string;
  machine_id?: string;
  valid_until?: number;
  message?: string;
  // v0.6 D6
  llm?: LlmConfig | null;
  byok?: LlmConfig;
  dev_mode?: boolean;
  suspend_reason?: string | null;
}

type Tab = 'console' | 'assets' | 'help';

export default function App() {
  const [licenseState, setLicenseState] = useState<LicenseState | null>(null);
  const [goStatus, setGoStatus] = useState<GoStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('console');
  const [appVersion, setAppVersion] = useState<string>('');
  const [xhsVisible, setXhsVisible] = useState<boolean>(false);

  useEffect(() => {
    void window.api.getVersion().then((v) => setAppVersion(v as string));
  }, []);

  useEffect(() => {
    let alive = true;
    window.api.license.status().then((s) => { if (alive) setLicenseState(s); });
    const unsubscribe = window.api.license.onChanged?.((state) => {
      if (alive) setLicenseState(state);
    });
    return () => {
      alive = false;
      unsubscribe?.();
    };
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

  // 独立 xhs BrowserWindow 可见性: main 进程 push + 首次 query
  useEffect(() => {
    if (licenseState?.status !== 'active') return;
    let alive = true;
    void window.api.xhs.isVisible().then((v) => { if (alive) setXhsVisible(v); });
    const unsub = window.api.xhs.onVisibilityChanged((v) => {
      if (alive) setXhsVisible(v);
    });
    return () => { alive = false; unsub(); };
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
          className={`tabbar__tab ${xhsVisible ? 'tabbar__tab--active' : ''}`}
          onClick={() => { void window.api.xhs.toggle(); }}
          title={xhsVisible ? '点击隐藏小红书窗口' : '点击显示小红书窗口'}
        >
          {xhsVisible ? '隐藏小红书' : '显示小红书'}
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
          v{appVersion || '?.?.?'} · {licenseState.code?.slice(-9) ?? ''} · 到 {validDate}
        </span>
        <button className="tabbar__icon" onClick={() => setSettingsOpen(true)} title="设置">⚙️</button>
      </div>

      <div className="tab-body">
        <div className={`tab-pane tab-pane--console ${tab === 'console' ? '' : 'tab-pane--hidden'}`}>
          <ConsolePane goOk={goStatus?.ok === true} onOpenSettings={() => setSettingsOpen(true)} />
        </div>

        <div className={`tab-pane tab-pane--assets ${tab === 'assets' ? '' : 'tab-pane--hidden'}`}>
          <AssetLibrary active={tab === 'assets'} />
        </div>

        <div className={`tab-pane tab-pane--help ${tab === 'help' ? '' : 'tab-pane--hidden'}`}>
          <HelpPanel devMode={licenseState.dev_mode === true} />
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
