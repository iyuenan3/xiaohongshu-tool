// BYOK 配置存取。
//
// 设计: 不预设 provider, 用户直接填 OpenAI 兼容三要素 (baseURL/apiKey/model)。
// 兼容: 火山方舟 / DeepSeek / Kimi / 智谱 / 通义 / OpenRouter / OpenAI 官方 / Ollama 等。
//
// 注: M2 阶段先用 localStorage 简化, M3 商业化阶段迁移到 safeStorage 防止恶意脚本读取。

export interface BYOKConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

const STORAGE_KEY = 'xhs.byok';

export function loadBYOK(): BYOKConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveBYOK(cfg: BYOKConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function clearBYOK(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function isBYOKConfigured(): boolean {
  const c = loadBYOK();
  return !!(c && c.apiKey && c.baseURL && c.model);
}
