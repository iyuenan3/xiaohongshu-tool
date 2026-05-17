import { useEffect, useState } from 'react';
import { loadBYOK, saveBYOK, type BYOKConfig } from '../ai/byok';

interface Props {
  onClose: () => void;
}

export default function Settings({ onClose }: Props) {
  const initial = loadBYOK() ?? { baseURL: '', apiKey: '', model: '' };
  const [cfg, setCfg] = useState<BYOKConfig>(initial);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string>('');
  const [logInfo, setLogInfo] = useState<{ path: string; size: number; exists: boolean } | null>(null);
  const [logBusy, setLogBusy] = useState(false);
  const [logMsg, setLogMsg] = useState<string>('');

  useEffect(() => {
    window.api.logs?.getInfo()
      .then((info) => setLogInfo(info))
      .catch((e) => setLogMsg(`读取日志信息失败: ${String(e)}`));
  }, []);

  const exportLog = async () => {
    setLogBusy(true);
    setLogMsg('');
    try {
      const r = await window.api.logs.export();
      if (r.canceled) {
        setLogMsg('已取消');
      } else if (r.ok && r.savedTo) {
        setLogMsg(`✓ 已保存到 ${r.savedTo}`);
      } else {
        setLogMsg(`× ${r.message ?? '导出失败'}`);
      }
    } catch (e) {
      setLogMsg(`× ${String(e)}`);
    }
    setLogBusy(false);
  };

  const openLogFolder = async () => {
    try {
      await window.api.logs.openFolder();
    } catch (e) {
      setLogMsg(`× ${String(e)}`);
    }
  };

  const formatBytes = (n: number): string => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult('测试中...');
    try {
      const r = await fetch(`${cfg.baseURL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: '你好' }],
          max_tokens: 10,
        }),
      });
      if (r.ok) {
        setTestResult('✓ 连接 OK, API key 和 model 都有效');
      } else {
        const t = await r.text();
        setTestResult(`× HTTP ${r.status}: ${t.slice(0, 200)}`);
      }
    } catch (e) {
      setTestResult(`× 网络错误: ${String(e)}`);
    }
    setTesting(false);
  };

  const save = () => {
    saveBYOK(cfg);
    onClose();
  };

  const valid = !!(cfg.apiKey && cfg.baseURL && cfg.model);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>AI 配置 (BYOK)</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </header>

        <div className="settings-body">
          <p className="hint" style={{ marginTop: 0, marginBottom: 8, borderTop: 'none', paddingTop: 0 }}>
            兼容 OpenAI 格式的任意 provider: 火山方舟 / DeepSeek / Kimi / 智谱 / 通义 / OpenRouter / OpenAI / Ollama 等。
          </p>

          <label>
            <span>Base URL</span>
            <input
              value={cfg.baseURL}
              onChange={(e) => setCfg({ ...cfg, baseURL: e.target.value })}
              placeholder="如: https://api.deepseek.com/v1"
            />
          </label>

          <label>
            <span>API Key</span>
            <input
              type="password"
              value={cfg.apiKey}
              onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
              placeholder="sk-..."
              autoComplete="off"
            />
          </label>

          <label>
            <span>Model</span>
            <input
              value={cfg.model}
              onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
              placeholder="如: deepseek-chat, doubao-1-5-pro-32k-250115, kimi-k2"
            />
          </label>

          <div className="settings-actions">
            <button onClick={testConnection} disabled={testing || !valid}>
              {testing ? '测试中...' : '测试连接'}
            </button>
            <button className="primary" onClick={save} disabled={!valid}>
              保存
            </button>
          </div>

          {testResult && (
            <p className="test-result" style={{ color: testResult.startsWith('✓') ? '#1f4d3a' : '#8b1f15' }}>
              {testResult}
            </p>
          )}

          <p className="hint">
            <strong>提示</strong>: baseURL 通常以 <code>/v1</code> 结尾, 不带 <code>/chat/completions</code>。
            常见 baseURL 参考:
            <br />· 火山方舟: <code>https://ark.cn-beijing.volces.com/api/v3</code>
            <br />· DeepSeek: <code>https://api.deepseek.com/v1</code>
            <br />· Kimi: <code>https://api.moonshot.cn/v1</code>
            <br />· OpenAI: <code>https://api.openai.com/v1</code>
          </p>

          <div className="settings-section">
            <h3 style={{ margin: '20px 0 8px', fontSize: 14, fontWeight: 600 }}>📋 故障排查 · 日志导出</h3>
            <p className="hint" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
              遇到问题时,导出日志发给客服,可以加速定位。日志包含 UI / Go 服务 / 工具调用 / 错误堆栈。
            </p>
            <div className="settings-actions">
              <button onClick={exportLog} disabled={logBusy || !logInfo?.exists}>
                {logBusy ? '导出中...' : '导出日志文件'}
              </button>
              <button onClick={openLogFolder} disabled={!logInfo?.exists}>打开日志目录</button>
            </div>
            {logInfo && (
              <p className="hint" style={{ marginTop: 8, fontSize: 12, color: '#666' }}>
                路径: <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{logInfo.path}</code>
                <br />大小: {logInfo.exists ? formatBytes(logInfo.size) : '文件未生成'}
              </p>
            )}
            {logMsg && (
              <p className="test-result" style={{ color: logMsg.startsWith('✓') ? '#1f4d3a' : '#8b1f15' }}>
                {logMsg}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
