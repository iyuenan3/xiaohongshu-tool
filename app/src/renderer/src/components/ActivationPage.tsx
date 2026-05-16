import { useEffect, useState } from 'react';

interface Props {
  onActivated: () => void;
  initialError?: string;
}

export default function ActivationPage({ onActivated, initialError }: Props) {
  const [machineId, setMachineId] = useState('');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(initialError ?? '');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    window.api.license.getMachineId().then(setMachineId);
  }, []);

  async function copyMachineId() {
    try {
      await navigator.clipboard.writeText(machineId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('复制失败，请手动选中复制');
    }
  }

  function formatCode(raw: string): string {
    const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const parts: string[] = [];
    if (cleaned.startsWith('XHS')) {
      parts.push('XHS');
      let rest = cleaned.slice(3);
      while (rest.length > 0) {
        parts.push(rest.slice(0, 4));
        rest = rest.slice(4);
        if (parts.length >= 5) break;
      }
    } else {
      parts.push('XHS');
      let rest = cleaned;
      while (rest.length > 0) {
        parts.push(rest.slice(0, 4));
        rest = rest.slice(4);
        if (parts.length >= 5) break;
      }
    }
    return parts.filter((p) => p.length > 0).join('-');
  }

  async function submit() {
    const trimmed = code.trim();
    if (!trimmed) {
      setError('请输入激活码');
      return;
    }
    if (!/^XHS-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(trimmed)) {
      setError('激活码格式错误，应为 XHS-XXXX-XXXX-XXXX-XXXX');
      return;
    }
    setError('');
    setSubmitting(true);
    const result = await window.api.license.activate(trimmed);
    setSubmitting(false);
    if (result.status === 'active') {
      onActivated();
    } else {
      setError(result.message ?? `激活失败 (${result.status})`);
    }
  }

  return (
    <div className="activation-page">
      <div className="activation-card">
        <div className="activation-eyebrow">激活</div>
        <h1 className="activation-title">小红书<em>自运营系统</em></h1>
        <p className="activation-lede">输入激活码以解锁全部功能。1 个激活码绑定 1 台设备。</p>

        <div className="activation-field">
          <label>激活码</label>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(formatCode(e.target.value))}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="XHS-XXXX-XXXX-XXXX-XXXX"
            disabled={submitting}
            spellCheck={false}
            autoFocus
          />
        </div>

        {error && <div className="activation-error">{error}</div>}

        <button
          className="activation-submit"
          onClick={submit}
          disabled={submitting || !code.trim()}
        >
          {submitting ? '正在激活...' : '激 活'}
        </button>

        <div className="activation-machine">
          <div className="activation-machine__label">本机机器码（换绑时给客服）</div>
          <div className="activation-machine__row">
            <code>{machineId || '加载中...'}</code>
            <button onClick={copyMachineId} disabled={!machineId}>
              {copied ? '✓ 已复制' : '复制'}
            </button>
          </div>
        </div>

        <div className="activation-footnote">
          没有激活码？请联系客服购买。<br />
          已激活但更换电脑？提供机器码联系客服换绑（每年 3 次免费）。
        </div>
      </div>
    </div>
  );
}
