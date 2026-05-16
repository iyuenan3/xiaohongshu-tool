import { app, safeStorage } from 'electron';
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

const PUBLIC_KEY_B64 = '8aC5Ujl8syPRmowRgYBPlbRFfkwM5/Eb3DKyLj7UKW8=';
const WORKER_URL = process.env.XHS_WORKER_URL ?? 'http://localhost:8787';
const MACHINE_SALT = 'xhs-app-v1';
const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type LicenseStatus =
  | 'unactivated'
  | 'active'
  | 'expired'
  | 'revoked'
  | 'mismatch'
  | 'error';

export interface LicenseState {
  status: LicenseStatus;
  code?: string;
  machine_id?: string;
  valid_until?: number;
  message?: string;
}

interface StoredLicense {
  token: string;
  code: string;
  machine_id: string;
  valid_until: number;
  last_heartbeat: number | null;
  revoked: boolean;
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

function loadStored(): StoredLicense | null {
  const p = licensePath();
  if (!existsSync(p)) return null;
  try {
    const buf = readFileSync(p);
    if (buf.length === 0) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      log.warn('[license] safeStorage unavailable; treating as unactivated');
      return null;
    }
    const plain = safeStorage.decryptString(buf);
    return JSON.parse(plain) as StoredLicense;
  } catch (e) {
    log.warn(`[license] loadStored failed: ${e}`);
    return null;
  }
}

function saveStored(data: StoredLicense): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption is not available on this platform');
  }
  const enc = safeStorage.encryptString(JSON.stringify(data));
  writeFileSync(licensePath(), enc);
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

  onActivated(cb: () => Promise<void> | void): void {
    this.onActivatedCb = cb;
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
      return { status: 'revoked', code: payload.code };
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.valid_until < now) {
      return { status: 'expired', code: payload.code, valid_until: payload.valid_until };
    }

    const myMachineId = getMachineId();
    if (payload.machine_id !== myMachineId) {
      return { status: 'mismatch', code: payload.code };
    }

    return {
      status: 'active',
      code: payload.code,
      machine_id: myMachineId,
      valid_until: payload.valid_until,
    };
  }

  async activate(rawCode: string): Promise<LicenseState> {
    const code = rawCode.trim().toUpperCase();
    const machine_id = getMachineId();

    let resp: Response;
    try {
      resp = await fetch(`${WORKER_URL}/activate`, {
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
    };
    saveStored(stored);
    this.cached = stored;
    this.cacheLoaded = true;
    log.info(`[license] activated. code=${code}, valid until ${body.valid_until}`);

    if (this.onActivatedCb) {
      try {
        await this.onActivatedCb();
      } catch (e) {
        log.warn(`[license] onActivated callback error: ${e}`);
      }
    }
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
      resp = await fetch(`${WORKER_URL}/heartbeat`, {
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
      return body;
    }

    if (body.revoked) {
      log.warn('[license] code revoked by server');
      this.cached.revoked = true;
      saveStored(this.cached);
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

    this.cached.last_heartbeat = Math.floor(Date.now() / 1000);
    saveStored(this.cached);
    return body;
  }

  startHeartbeatScheduler(): void {
    if (this.heartbeatTimer) return;
    this.heartbeat().catch((e) => log.warn(`[license] initial heartbeat error: ${e}`));
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch((e) => log.warn(`[license] periodic heartbeat error: ${e}`));
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeatScheduler(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  clear(): void {
    clearStored();
    this.cached = null;
    this.cacheLoaded = true;
    this.stopHeartbeatScheduler();
  }
}

export const licenseManager = new LicenseManager();
