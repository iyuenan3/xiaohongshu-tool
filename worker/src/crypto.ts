import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import type { SignedTokenPayload } from './types';
import { b64, utf8 } from './util';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

let _pubKeyCache: string | null = null;
export async function derivePublicKey(privateKeyB64: string): Promise<string> {
  if (_pubKeyCache) return _pubKeyCache;
  const pk = await ed.getPublicKeyAsync(b64.decode(privateKeyB64));
  _pubKeyCache = b64.encode(pk);
  return _pubKeyCache;
}

export async function signToken(
  payload: SignedTokenPayload,
  privateKeyB64: string,
): Promise<string> {
  const privateKey = b64.decode(privateKeyB64);
  const payloadBytes = utf8.encode(JSON.stringify(payload));
  const sig = await ed.signAsync(payloadBytes, privateKey);
  return b64.encode(payloadBytes) + '.' + b64.encode(sig);
}

export async function verifyToken(
  token: string,
  publicKeyB64: string,
): Promise<SignedTokenPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const payloadBytes = b64.decode(parts[0]);
    const sig = b64.decode(parts[1]);
    const publicKey = b64.decode(publicKeyB64);
    const valid = await ed.verifyAsync(sig, payloadBytes, publicKey);
    if (!valid) return null;
    return JSON.parse(utf8.decode(payloadBytes)) as SignedTokenPayload;
  } catch {
    return null;
  }
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateCode(): string {
  const seg = () => {
    const a = new Uint8Array(4);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => ALPHABET[b % ALPHABET.length]).join('');
  };
  return `XHS-${seg()}-${seg()}-${seg()}-${seg()}`;
}

export function isValidCode(code: string): boolean {
  return /^XHS-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);
}

// v0.6 D6: newapi api_key AES-GCM 加密 (key 从 SIGNING_PRIVATE_KEY 派生)
// 用途: KV 存 api_key 用密文, 即便 admin token 泄露读 KV 也拿不到明文 sk-xxx

async function deriveAesKey(privateKeyB64: string): Promise<CryptoKey> {
  const raw = b64.decode(privateKeyB64);
  // SHA-256(SIGNING_PRIVATE_KEY) 派生 32 字节 AES key (跟签名 key 解耦)
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptApiKey(apiKey: string, privateKeyB64: string): Promise<string> {
  const key = await deriveAesKey(privateKeyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8.encode(apiKey));
  // 输出格式: base64(iv) + '.' + base64(ciphertext)
  return b64.encode(iv) + '.' + b64.encode(new Uint8Array(ciphertext));
}

export async function decryptApiKey(encrypted: string, privateKeyB64: string): Promise<string> {
  const parts = encrypted.split('.');
  if (parts.length !== 2) throw new Error('invalid encrypted api_key format');
  const iv = b64.decode(parts[0]);
  const ciphertext = b64.decode(parts[1]);
  const key = await deriveAesKey(privateKeyB64);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return utf8.decode(new Uint8Array(plaintext));
}
