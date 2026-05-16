import type { Env, CodeRecord } from './types';

const CODE_KEY = (code: string) => `code:${code}`;
const RATE_KEY = (ip: string, kind: string) => `rate:${kind}:${ip}`;
const CONFIG_KEY = (key: string) => `config:${key}`;

export async function getCode(env: Env, code: string): Promise<CodeRecord | null> {
  const raw = await env.LICENSES.get(CODE_KEY(code));
  return raw ? (JSON.parse(raw) as CodeRecord) : null;
}

export async function putCode(env: Env, code: string, rec: CodeRecord): Promise<void> {
  await env.LICENSES.put(CODE_KEY(code), JSON.stringify(rec));
}

export async function getConfig(env: Env, key: string, fallback: string): Promise<string> {
  return (await env.LICENSES.get(CONFIG_KEY(key))) ?? fallback;
}

export async function checkRate(
  env: Env,
  ip: string,
  kind: string,
  max: number,
  windowSec = 60,
): Promise<boolean> {
  const key = RATE_KEY(ip, kind);
  const cur = parseInt((await env.LICENSES.get(key)) ?? '0', 10);
  if (cur >= max) return false;
  await env.LICENSES.put(key, String(cur + 1), { expirationTtl: windowSec });
  return true;
}
