import { app, net } from 'electron';
import { machineIdSync } from 'node-machine-id';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import log from 'electron-log/main';

// @noble/ed25519 v3 API: 必须先注入 sha512 才能调用 sign/verify
// (类型断言绕过 @noble/hashes 与 @noble/ed25519 d.ts 间的微小不兼容)
ed.hashes.sha512 = sha512 as unknown as typeof ed.hashes.sha512;

const PUBLIC_KEY_B64 = '0TVH+g8Gl0cAVAhTLfL6+r7sQ3ZpQ26H0ApnBEkePVQ=';  // v0.8 迁 bj 轮换 (旧 8aC5… 曾泄漏作废)
const WORKER_URL = process.env.XHS_WORKER_URL ?? 'https://39.96.12.136:8888/xhs-lic';
const MACHINE_SALT = 'xhs-app-v1';
// v0.7.1: 24h → 1h + ±5min jitter. 让 revoke/CODE_NOT_FOUND 1h 内生效 (24h 太迟).
// CF Workers 压力: 1000 用户 × 24 次/天 ≈ 720k/月, Paid tier 7.2% (Free tier 也够 100 用户内).
// Jitter 防 N 个用户同时启动后心跳卡到同一分钟 burst.
const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000;
const HEARTBEAT_JITTER_MS = 5 * 60 * 1000;

export type LicenseStatus =
  | 'unactivated'
  | 'active'
  | 'suspended'       // v0.6 D6: LLM 月费未续, 软停 (chat 锁, 软件其他功能仍可用)
  | 'expired'
  | 'revoked'
  | 'mismatch'
  | 'error';

export interface LlmConfig {
  base_url: string;
  api_key: string;
  model: string;
}

export interface LicenseState {
  status: LicenseStatus;
  code?: string;
  machine_id?: string;
  valid_until?: number;
  message?: string;
  // v0.6 D6
  llm?: LlmConfig | null;       // 中转 LLM 配置 (默认走这个)
  byok?: LlmConfig;             // dev 模式 BYOK 配置
  dev_mode?: boolean;           // dev 模式状态 (持久化)
  suspend_reason?: string | null;   // 仅运营内部, banner 用固定文案
}

interface StoredLicense {
  token: string;
  code: string;
  machine_id: string;
  valid_until: number;
  last_heartbeat: number | null;
  revoked: boolean;
  // v0.6 D6 新增 (向下兼容 — 字段缺失视为默认值)
  server_status?: 'active' | 'suspended' | 'revoked';   // Worker 同步的 status, heartbeat 更新
  suspend_reason?: string | null;
  llm?: LlmConfig | null;
  byok?: LlmConfig;
  dev_mode?: boolean;
}

interface TokenPayload {
  code: string;
  machine_id: string;
  issued_at: number;
  valid_until: number;
}

interface ActivateResponse {
  ok: boolean;
  token?: string;
  valid_until?: string;
  code?: string;
  message?: string;
  // v0.6 D6
  status?: 'active' | 'suspended';
  llm?: LlmConfig | null;
}

interface HeartbeatResponse {
  ok: boolean;
  latest_version?: string;
  min_version?: string;
  revoked?: boolean;
  new_token?: string;
  new_valid_until?: string;
  code?: string;
  message?: string;
  // v0.6 D6
  status?: 'active' | 'suspended' | 'revoked';
  suspend_reason?: string | null;
  llm?: LlmConfig | null;
}

const b64 = {
  encode: (data: Uint8Array): string => Buffer.from(data).toString('base64'),
  decode: (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64')),
};

function licensePath(): string {
  return join(app.getPath('userData'), 'license.bin');
}

let _machineIdCache: string | null = null;
function getMachineId(): string {
  if (_machineIdCache) return _machineIdCache;
  const raw = machineIdSync(true);
  _machineIdCache = createHash('sha256').update(`${MACHINE_SALT}:${raw}`).digest('hex');
  return _machineIdCache;
}

async function verifyToken(token: string): Promise<TokenPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const payloadBytes = b64.decode(parts[0]);
    const sig = b64.decode(parts[1]);
    const pub = b64.decode(PUBLIC_KEY_B64);
    const valid = await ed.verifyAsync(sig, payloadBytes, pub);
    if (!valid) return null;
    return JSON.parse(new TextDecoder().decode(payloadBytes)) as TokenPayload;
  } catch (e) {
    log.warn(`[license] verifyToken error: ${e}`);
    return null;
  }
}

// 文件存储 (base64 编码): license token + machine_id 绑定. 安全保障由服务端 verify
// machine_id 提供, 客户端不再加密 (省去 Keychain 弹窗 UX 损失). 旧 safeStorage 加密
// 数据无法解读 → 当未激活处理, 用户重新输激活码即可.
function loadStored(): StoredLicense | null {
  const p = licensePath();
  if (!existsSync(p)) return null;
  try {
    const buf = readFileSync(p);
    if (buf.length === 0) return null;
    const plain = Buffer.from(buf.toString('utf8'), 'base64').toString('utf8');
    return JSON.parse(plain) as StoredLicense;
  } catch (e) {
    log.warn(`[license] loadStored failed (旧 safeStorage 数据将被忽略): ${e}`);
    return null;
  }
}

function saveStored(data: StoredLicense): void {
  const enc = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
  writeFileSync(licensePath(), enc, 'utf8');
}

function clearStored(): void {
  const p = licensePath();
  if (existsSync(p)) {
    try { unlinkSync(p); } catch (e) { log.warn(`[license] unlink failed: ${e}`); }
  }
}

export class LicenseManager {
  private cached: StoredLicense | null = null;
  private cacheLoaded = false;
  private onActivatedCb: (() => Promise<void> | void) | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private changeListeners: Array<(state: LicenseState) => void> = [];

  onActivated(cb: () => Promise<void> | void): void {
    this.onActivatedCb = cb;
  }

  /** 注册 license 状态变化监听 (activate/heartbeat-revoked/clear 触发), 返回 unsubscribe. */
  onChanged(cb: (state: LicenseState) => void): () => void {
    this.changeListeners.push(cb);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== cb);
    };
  }

  private async emitChange(): Promise<void> {
    let state: LicenseState;
    try {
      state = await this.getStatus();
    } catch (e) {
      log.warn(`[license] emitChange getStatus failed: ${e}`);
      return;
    }
    for (const cb of this.changeListeners) {
      try { cb(state); } catch (e) { log.warn(`[license] change listener error: ${e}`); }
    }
  }

  getMachineIdPublic(): string {
    return getMachineId();
  }

  async getStatus(): Promise<LicenseState> {
    if (!this.cacheLoaded) {
      this.cached = loadStored();
      this.cacheLoaded = true;
    }
    if (!this.cached) return { status: 'unactivated' };

    const payload = await verifyToken(this.cached.token);
    if (!payload) {
      log.warn('[license] cached token failed signature check; clearing');
      this.cached = null;
      clearStored();
      return { status: 'error', message: 'token 签名校验失败，请重新激活' };
    }

    if (this.cached.revoked) {
      return this.buildState('revoked', payload);
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.valid_until < now) {
      return this.buildState('expired', payload, { valid_until: payload.valid_until });
    }

    const myMachineId = getMachineId();
    if (payload.machine_id !== myMachineId) {
      return this.buildState('mismatch', payload);
    }

    // v0.6 D6: server_status === 'suspended' 时 status=suspended (chat 锁, 软件其他正常)
    if (this.cached.server_status === 'suspended') {
      return this.buildState('suspended', payload);
    }

    return this.buildState('active', payload, {
      machine_id: myMachineId,
      valid_until: payload.valid_until,
    });
  }

  /** v0.6 D6: 统一构造 LicenseState, 带 llm/byok/dev_mode/suspend_reason */
  private buildState(
    status: LicenseStatus,
    payload: TokenPayload,
    extra?: Partial<LicenseState>,
  ): LicenseState {
    return {
      status,
      code: payload.code,
      llm: this.cached?.llm ?? null,
      byok: this.cached?.byok,
      dev_mode: this.cached?.dev_mode ?? false,
      suspend_reason: this.cached?.suspend_reason ?? null,
      ...extra,
    };
  }

  async activate(rawCode: string): Promise<LicenseState> {
    const code = rawCode.trim().toUpperCase();
    const machine_id = getMachineId();

    let resp: Response;
    try {
      resp = await net.fetch(`${WORKER_URL}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, machine_id }),
      });
    } catch (e) {
      log.error(`[license] activate fetch failed: ${e}`);
      return { status: 'error', message: `网络错误，无法连接激活服务（${WORKER_URL}）` };
    }

    const body = (await resp.json()) as ActivateResponse;
    if (!body.ok || !body.token || !body.valid_until) {
      log.warn(`[license] activate rejected: ${body.code} - ${body.message}`);
      return { status: 'error', message: body.message ?? body.code ?? '激活失败' };
    }

    const valid_until = Math.floor(new Date(body.valid_until).getTime() / 1000);
    const stored: StoredLicense = {
      token: body.token,
      code,
      machine_id,
      valid_until,
      last_heartbeat: Math.floor(Date.now() / 1000),
      revoked: false,
      // v0.6 D6
      server_status: body.status ?? 'active',
      suspend_reason: null,
      llm: body.llm ?? null,
      byok: this.cached?.byok,   // 保留 dev 模式 BYOK 配置 (重激活不丢)
      dev_mode: this.cached?.dev_mode ?? false,
    };
    saveStored(stored);
    this.cached = stored;
    this.cacheLoaded = true;
    log.info(`[license] activated. code=${code}, valid until ${body.valid_until}, llm=${body.llm ? 'ok' : 'null'}`);

    if (this.onActivatedCb) {
      try {
        await this.onActivatedCb();
      } catch (e) {
        log.warn(`[license] onActivated callback error: ${e}`);
      }
    }
    void this.emitChange();
    return { status: 'active', code, machine_id, valid_until };
  }

  async heartbeat(): Promise<HeartbeatResponse> {
    if (!this.cacheLoaded) {
      this.cached = loadStored();
      this.cacheLoaded = true;
    }
    if (!this.cached) return { ok: false, code: 'NOT_ACTIVATED', message: 'not activated' };

    let resp: Response;
    try {
      resp = await net.fetch(`${WORKER_URL}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: this.cached.token }),
      });
    } catch (e) {
      log.warn(`[license] heartbeat fetch failed: ${e}`);
      return { ok: false, code: 'NETWORK_ERROR', message: String(e) };
    }
    const body = (await resp.json()) as HeartbeatResponse;
    if (!body.ok) {
      log.warn(`[license] heartbeat rejected: ${body.code}`);
      // v0.7.1: CODE_NOT_FOUND (KV 被 admin 真删) / CODE_REVOKED 跟 revoked=true 同样处理,
      // 设 cached.revoked 触发 emitChange 锁 UI. 老版本只 silent log, UI 不更新.
      if (this.cached && (body.code === 'CODE_NOT_FOUND' || body.code === 'CODE_REVOKED')) {
        log.warn(`[license] code revoked / not-found by server (${body.code}), locking UI`);
        this.cached.revoked = true;
        this.cached.server_status = 'revoked';
        saveStored(this.cached);
        void this.emitChange();
      }
      return body;
    }

    if (body.revoked) {
      log.warn('[license] code revoked by server');
      this.cached.revoked = true;
      this.cached.server_status = 'revoked';
      saveStored(this.cached);
      void this.emitChange();
      return body;
    }

    if (body.new_token && body.new_valid_until) {
      const payload = await verifyToken(body.new_token);
      if (payload) {
        this.cached.token = body.new_token;
        this.cached.valid_until = payload.valid_until;
        log.info(`[license] token renewed to ${body.new_valid_until}`);
      }
    }

    // v0.6 D6: diff incoming status / suspend_reason / llm, 不一致触发 emitChange
    let changed = false;
    if (body.status && body.status !== this.cached.server_status) {
      log.info(`[license] server_status changed: ${this.cached.server_status} → ${body.status}`);
      this.cached.server_status = body.status;
      changed = true;
    }
    if (body.suspend_reason !== undefined && body.suspend_reason !== this.cached.suspend_reason) {
      this.cached.suspend_reason = body.suspend_reason;
      changed = true;
    }
    if (body.llm !== undefined) {
      const oldLlm = this.cached.llm;
      const newLlm = body.llm;
      const oldKey = oldLlm ? `${oldLlm.base_url}|${oldLlm.api_key}|${oldLlm.model}` : 'null';
      const newKey = newLlm ? `${newLlm.base_url}|${newLlm.api_key}|${newLlm.model}` : 'null';
      if (oldKey !== newKey) {
        log.info(`[license] llm config changed (base_url=${newLlm?.base_url ?? 'null'})`);
        this.cached.llm = newLlm;
        changed = true;
      }
    }

    this.cached.last_heartbeat = Math.floor(Date.now() / 1000);
    saveStored(this.cached);
    if (changed) void this.emitChange();
    return body;
  }

  // v0.6 D6: dev 模式 / BYOK 配置 API (renderer 通过 IPC 调用)

  async getActiveLlm(): Promise<LlmConfig | null> {
    if (!this.cacheLoaded) {
      this.cached = loadStored();
      this.cacheLoaded = true;
    }
    if (!this.cached) return null;
    return this.cached.dev_mode === true && this.cached.byok ? this.cached.byok : this.cached.llm ?? null;
  }

  async setDevMode(enabled: boolean): Promise<void> {
    if (!this.cached) return;
    this.cached.dev_mode = enabled;
    saveStored(this.cached);
    log.info(`[license] dev_mode set to ${enabled}`);
    void this.emitChange();
  }

  async setByok(byok: LlmConfig): Promise<void> {
    if (!this.cached) return;
    this.cached.byok = byok;
    saveStored(this.cached);
    log.info('[license] byok updated');
    void this.emitChange();
  }

  /** 客户端调 Worker /quota 查 subscription 余额, sig = 当前 token */
  async fetchQuota(): Promise<{
    remain_cny: number; total_cny: number; used_cny: number; next_reset_at: number;
  } | null> {
    if (!this.cached) return null;
    const params = new URLSearchParams({ code: this.cached.code, sig: this.cached.token });
    try {
      const resp = await net.fetch(`${WORKER_URL}/quota?${params}`);
      const body = await resp.json() as Record<string, unknown> & { ok: boolean };
      if (!body.ok) return null;
      return body as unknown as { remain_cny: number; total_cny: number; used_cny: number; next_reset_at: number };
    } catch (e) {
      log.warn(`[license] fetchQuota failed: ${e}`);
      return null;
    }
  }

  startHeartbeatScheduler(): void {
    if (this.heartbeatTimer) return;
    this.heartbeat().catch((e) => log.warn(`[license] initial heartbeat error: ${e}`));
    // 用 setTimeout 而不是 setInterval, 每次重算 next delay 加 jitter
    const scheduleNext = (): void => {
      const jitter = (Math.random() * 2 - 1) * HEARTBEAT_JITTER_MS;  // ±5min
      const delay = HEARTBEAT_INTERVAL_MS + jitter;
      this.heartbeatTimer = setTimeout(() => {
        this.heartbeat().catch((e) => log.warn(`[license] periodic heartbeat error: ${e}`));
        scheduleNext();
      }, delay);
    };
    scheduleNext();
  }

  stopHeartbeatScheduler(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);   // v0.7.1 改用 setTimeout, clearTimeout 对应
      this.heartbeatTimer = null;
    }
  }

  clear(): void {
    clearStored();
    this.cached = null;
    this.cacheLoaded = true;
    this.stopHeartbeatScheduler();
    void this.emitChange();
  }
}

export const licenseManager = new LicenseManager();
