import { useEffect, useState } from 'react';
import { saveDevBYOK, setDevMode, type BYOKConfig } from '../ai/byok';

interface Props {
  onClose: () => void;
}

interface QuotaInfo {
  remain_cny: number;
  total_cny: number;
  used_cny: number;
  next_reset_at: number;
}

interface LicenseInfo {
  status: 'unactivated' | 'active' | 'suspended' | 'expired' | 'revoked' | 'mismatch' | 'error';
  code?: string;
  llm?: { base_url: string; api_key: string; model: string } | null;
  byok?: { base_url: string; api_key: string; model: string };
  dev_mode?: boolean;
  suspend_reason?: string | null;
}

// 暗号: 真值见 ~/.secrets/xhs-secrets.txt (源码硬编码, D8 改 public 后建议改 process.env 注入)
const DEV_UNLOCK_CODE = 'doubleLyuzhouwudidashuaige';

export default function Settings({ onClose }: Props) {
  // license + LLM 配置
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const [byokCfg, setByokCfg] = useState<BYOKConfig>({ baseURL: '', apiKey: '', model: '' });
  const [byokSaving, setByokSaving] = useState(false);

  // 配额
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [quotaBusy, setQuotaBusy] = useState(false);

  // 反馈框 + dev 解锁
  const [feedbackText, setFeedbackText] = useState('');

  // 日志导出 (保留)
  const [logInfo, setLogInfo] = useState<{ path: string; size: number; exists: boolean } | null>(null);
  const [logBusy, setLogBusy] = useState(false);
  const [logMsg, setLogMsg] = useState<string>('');

  // 初始化: 拉 license / quota / log info
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const s = await window.api.license.status();
      if (!alive) return;
      setLicense(s as LicenseInfo);
      if (s.byok) {
        setByokCfg({
          baseURL: s.byok.base_url,
          apiKey: s.byok.api_key,
          model: s.byok.model,
        });
      }
    };
    refresh();
    const unsub = window.api.license.onChanged?.(refresh);
    window.api.logs?.getInfo()
      .then((info) => { if (alive) setLogInfo(info); })
      .catch((e) => setLogMsg(`读取日志信息失败: ${String(e)}`));
    refreshQuota();
    return () => { alive = false; unsub?.(); };
  }, []);

  const refreshQuota = async () => {
    setQuotaBusy(true);
    try {
      const q = await window.api.llm.getQuota();
      setQuota(q);
    } finally {
      setQuotaBusy(false);
    }
  };

  // 反馈框 onChange 检测暗号
  useEffect(() => {
    if (feedbackText === DEV_UNLOCK_CODE) {
      const enable = window.confirm(
        '已解锁开发者模式, BYOK 配置区将显示, 可在中转 / BYOK 间切换。\n\n确认进入开发者模式?',
      );
      if (enable) {
        setDevMode(true);
        setFeedbackText('');   // 清空避免重复触发
      } else {
        setFeedbackText('');
      }
    }
  }, [feedbackText]);

  // 日志相关
  const exportLog = async () => {
    setLogBusy(true);
    setLogMsg('');
    try {
      const r = await window.api.logs.export();
      if (r.canceled) setLogMsg('已取消');
      else if (r.ok && r.savedTo) setLogMsg(`✓ 已保存到 ${r.savedTo}`);
      else setLogMsg(`× ${r.message ?? '导出失败'}`);
    } catch (e) {
      setLogMsg(`× ${String(e)}`);
    }
    setLogBusy(false);
  };

  const openLogFolder = async () => {
    try { await window.api.logs.openFolder(); }
    catch (e) { setLogMsg(`× ${String(e)}`); }
  };

  const formatBytes = (n: number): string => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  };

  const formatCny = (n: number): string => `¥${n.toFixed(2)}`;
  const formatResetTime = (unixTs: number): string => {
    const d = new Date(unixTs * 1000);
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  // BYOK 保存 (dev 模式可见)
  const saveByok = async () => {
    setByokSaving(true);
    try {
      await saveDevBYOK(byokCfg);
      setLogMsg('✓ BYOK 已保存, 下次 chat 调用生效');
    } catch (e) {
      setLogMsg(`× BYOK 保存失败: ${String(e)}`);
    }
    setByokSaving(false);
  };

  const exitDevMode = async () => {
    if (!window.confirm('退出开发者模式? BYOK 配置将保留但不再使用, agent 切回中转 LLM.')) return;
    await setDevMode(false);
  };

  const byokValid = !!(byokCfg.apiKey && byokCfg.baseURL && byokCfg.model);
  const devMode = license?.dev_mode === true;
  const llmModeLabel = devMode ? '开发者模式 · BYOK' : '中转模式 (默认)';

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>设置</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </header>

        <div className="settings-body">
          {/* === AI 调用额度 === */}
          <div className="settings-section">
            <h3 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600 }}>💎 AI 调用额度</h3>
            {license?.status === 'active' && quota ? (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 20, fontWeight: 600, color: '#1f4d3a' }}>
                    {formatCny(quota.remain_cny)}
                  </span>
                  <span style={{ fontSize: 12, color: '#666' }}>
                    / {formatCny(quota.total_cny)} (已用 {formatCny(quota.used_cny)})
                  </span>
                </div>
                <progress value={quota.remain_cny} max={quota.total_cny} style={{ width: '100%' }} />
                <p className="hint" style={{ marginTop: 4, borderTop: 'none', paddingTop: 0, fontSize: 11 }}>
                  下次重置: {formatResetTime(quota.next_reset_at)} (newapi 月度自动 reset)
                  <br />当前模式: <strong>{llmModeLabel}</strong>
                </p>
                <div className="settings-actions" style={{ marginTop: 6 }}>
                  <button onClick={refreshQuota} disabled={quotaBusy}>
                    {quotaBusy ? '刷新中...' : '刷新'}
                  </button>
                </div>
              </>
            ) : license?.status === 'suspended' ? (
              <p className="hint" style={{ color: '#c97300', borderTop: 'none', paddingTop: 0 }}>
                AI 服务已暂停, 请联系客服续费 LLM 服务. 续费后立即恢复。
              </p>
            ) : license?.status === 'revoked' ? (
              <p className="hint" style={{ color: '#8b1f15', borderTop: 'none', paddingTop: 0 }}>
                软件已停用, 如有疑问请联系客服。
              </p>
            ) : (
              <p className="hint" style={{ borderTop: 'none', paddingTop: 0 }}>
                {quotaBusy ? '加载中...' : '激活软件后显示配额'}
              </p>
            )}
          </div>

          {/* === 故障排查 / 反馈框 (常驻 UI, 兼 dev 解锁入口) === */}
          <div className="settings-section">
            <h3 style={{ margin: '20px 0 8px', fontSize: 14, fontWeight: 600 }}>📋 故障排查 / 反馈</h3>
            <p className="hint" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
              遇到问题时, 描述并导出日志发给客服。
            </p>
            <textarea
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              placeholder="描述你遇到的问题, 复制后跟日志一起发给客服..."
              rows={3}
              style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 13, padding: 8 }}
            />
            <div className="settings-actions" style={{ marginTop: 6 }}>
              <button onClick={exportLog} disabled={logBusy || !logInfo?.exists}>
                {logBusy ? '导出中...' : '导出日志文件'}
              </button>
              <button onClick={openLogFolder} disabled={!logInfo?.exists}>打开日志目录</button>
            </div>
            {logInfo && (
              <p className="hint" style={{ marginTop: 8, fontSize: 11, color: '#666', borderTop: 'none', paddingTop: 0 }}>
                日志: <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{logInfo.path}</code>
                {logInfo.exists ? ` (${formatBytes(logInfo.size)})` : ' (未生成)'}
              </p>
            )}
            {logMsg && (
              <p className="test-result" style={{ color: logMsg.startsWith('✓') ? '#1f4d3a' : '#8b1f15' }}>
                {logMsg}
              </p>
            )}
          </div>

          {/* === Dev 模式 BYOK 配置 (默认隐藏) === */}
          {devMode && (
            <div className="settings-section" style={{ borderTop: '2px dashed #ccc', paddingTop: 16 }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600, color: '#8b1f15' }}>
                ⚙️ 开发者模式 · BYOK 配置
              </h3>
              <p className="hint" style={{ marginTop: 0, marginBottom: 12, borderTop: 'none', paddingTop: 0 }}>
                兼容 OpenAI 格式 (火山方舟 / DeepSeek / Kimi / 通义 / OpenAI / Ollama 等).
                <br />填后软件 LLM 调用切到此配置 (中转 LLM 仍保留, 关闭 dev 模式即恢复).
              </p>

              <label>
                <span>Base URL</span>
                <input
                  value={byokCfg.baseURL}
                  onChange={(e) => setByokCfg({ ...byokCfg, baseURL: e.target.value })}
                  placeholder="如: https://api.deepseek.com/v1"
                />
              </label>

              <label>
                <span>API Key</span>
                <input
                  type="password"
                  value={byokCfg.apiKey}
                  onChange={(e) => setByokCfg({ ...byokCfg, apiKey: e.target.value })}
                  placeholder="sk-..."
                  autoComplete="off"
                />
              </label>

              <label>
                <span>Model</span>
                <input
                  value={byokCfg.model}
                  onChange={(e) => setByokCfg({ ...byokCfg, model: e.target.value })}
                  placeholder="如: deepseek-chat, doubao-1-5-pro-32k, kimi-k2"
                />
              </label>

              <div className="settings-actions">
                <button className="primary" onClick={saveByok} disabled={!byokValid || byokSaving}>
                  {byokSaving ? '保存中...' : '保存 BYOK'}
                </button>
                <button onClick={exitDevMode}>退出开发者模式</button>
              </div>

              <p className="hint" style={{ fontSize: 11 }}>
                常见 baseURL: 火山 <code>ark.cn-beijing.volces.com/api/v3</code> · DeepSeek <code>api.deepseek.com/v1</code> · Kimi <code>api.moonshot.cn/v1</code>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
