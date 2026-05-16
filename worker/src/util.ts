import type { ErrorCode } from './types';

export const b64 = {
  encode(data: Uint8Array): string {
    let s = '';
    for (const b of data) s += String.fromCharCode(b);
    return btoa(s);
  },
  decode(s: string): Uint8Array {
    const bin = atob(s);
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  },
};

export const utf8 = {
  encode: (s: string): Uint8Array => new TextEncoder().encode(s),
  decode: (b: Uint8Array): string => new TextDecoder().decode(b),
};

export function ok<T extends object>(body: T): Response {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function err(code: ErrorCode, message: string, status = 400): Response {
  return new Response(JSON.stringify({ ok: false, code, message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

export function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? 'unknown';
}
