// v0.6 D6: LLM 配置统一通过 main 进程 license 拿
// - 默认模式 (license.dev_mode === false): license.llm (中转, 由 Worker /activate /heartbeat 下发)
// - Dev 模式 (license.dev_mode === true): license.byok (用户自填, 通过 Settings UI 写入)
//
// 旧 localStorage 'xhs.byok' 已废弃, dev 模式 BYOK 配置改由主进程 license.json 持久化

export interface BYOKConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

/**
 * 拿当前生效的 LLM 配置。
 * 主进程 license.ts 内部判断 (dev_mode ? byok : llm), 返回对应配置。
 * @returns null 表示未激活 / 中转未下发 / dev 模式未配置 BYOK
 */
export async function loadActiveLLM(): Promise<BYOKConfig | null> {
  const llm = await window.api.llm.getActive();
  if (!llm || !llm.api_key || !llm.base_url || !llm.model) return null;
  return {
    baseURL: llm.base_url,
    apiKey: llm.api_key,
    model: llm.model,
  };
}

/** 同步快照: 从 React store 读 (App.tsx 会维护 licenseState)。仅用于非 async 上下文 (e.g. Settings 显示). */
export function activeLlmFromState(state: {
  dev_mode?: boolean;
  llm?: { base_url: string; api_key: string; model: string } | null;
  byok?: { base_url: string; api_key: string; model: string };
} | null): BYOKConfig | null {
  if (!state) return null;
  const src = state.dev_mode === true ? state.byok : state.llm;
  if (!src || !src.api_key || !src.base_url || !src.model) return null;
  return { baseURL: src.base_url, apiKey: src.api_key, model: src.model };
}

/** Dev 模式: 保存用户自填的 BYOK 配置 (写到 main 进程 license.byok) */
export async function saveDevBYOK(cfg: BYOKConfig): Promise<void> {
  await window.api.llm.setByok({
    base_url: cfg.baseURL,
    api_key: cfg.apiKey,
    model: cfg.model,
  });
}

/** Dev 模式: 不落盘，验证 endpoint / key / model 与 tools 能力。 */
export async function testDevBYOK(cfg: BYOKConfig): Promise<{ ok: boolean; message: string }> {
  return window.api.llm.testByok({
    base_url: cfg.baseURL.trim().replace(/\/+$/, ''),
    api_key: cfg.apiKey.trim(),
    model: cfg.model.trim(),
  });
}

export async function setDevMode(enabled: boolean): Promise<void> {
  await window.api.llm.setDevMode(enabled);
}

export function isLlmConfigured(state: Parameters<typeof activeLlmFromState>[0]): boolean {
  return activeLlmFromState(state) !== null;
}
