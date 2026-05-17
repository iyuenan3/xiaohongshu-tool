// Renderer → main.log 透传小工具
// 设计原则: 永不抛错 (fire-and-forget), 写不进就吞掉; 自动截断长字符串避免日志膨胀

const MAX_LEN = 600;

function truncate(s: string, max = MAX_LEN): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[truncated ${s.length - max} chars]`;
}

function send(level: 'info' | 'warn' | 'error', scope: string, msg: string): void {
  try {
    const api = (window as unknown as { api?: { logs?: { write?: (l: string, s: string, m: string) => Promise<unknown> } } }).api;
    api?.logs?.write?.(level, scope, truncate(msg))?.catch(() => {
      // ignore
    });
  } catch {
    // ignore
  }
}

export const rlog = {
  info: (scope: string, msg: string) => send('info', scope, msg),
  warn: (scope: string, msg: string) => send('warn', scope, msg),
  error: (scope: string, msg: string) => send('error', scope, msg),
};

// 安全 json 序列化 + 截断, 处理循环引用 / Error 实例
export function safeJson(v: unknown, max = MAX_LEN): string {
  let s: string;
  try {
    if (v instanceof Error) s = `${v.name}: ${v.message}`;
    else if (typeof v === 'string') s = v;
    else s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max)}…[+${s.length - max}]` : s;
}
