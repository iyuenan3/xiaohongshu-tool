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
