import { useState } from 'react';
import { loadBYOK, saveBYOK, type BYOKConfig } from '../ai/byok';

interface Props {
  onClose: () => void;
}

export default function Settings({ onClose }: Props) {
  const initial = loadBYOK() ?? { baseURL: '', apiKey: '', model: '' };
  const [cfg, setCfg] = useState<BYOKConfig>(initial);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string>('');

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
        </div>
      </div>
    </div>
  );
}
