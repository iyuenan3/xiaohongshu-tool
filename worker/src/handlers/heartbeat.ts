import type { Env, HeartbeatRequest } from '../types';
import { derivePublicKey, signToken, verifyToken } from '../crypto';
import { checkRate, getCode, getConfig } from '../kv';
import { clientIp, err, ok, unixNow } from '../util';

const RENEW_WINDOW_DAYS = 60;
const NEW_VALID_DAYS = 365;

export async function handleHeartbeat(req: Request, env: Env): Promise<Response> {
  const ip = clientIp(req);
  if (!(await checkRate(env, ip, 'heartbeat', 30))) {
    return err('RATE_LIMITED', 'too many heartbeats', 429);
  }

  let body: HeartbeatRequest;
  try {
    body = (await req.json()) as HeartbeatRequest;
  } catch {
    return err('BAD_REQUEST', 'invalid JSON body');
  }
  if (!body?.token) {
    return err('INVALID_TOKEN', 'missing token');
  }

  const publicKey = await derivePublicKey(env.SIGNING_PRIVATE_KEY);
  const payload = await verifyToken(body.token, publicKey);
  if (!payload) return err('INVALID_TOKEN', '令牌无效或已被篡改');

  const now = unixNow();
  if (payload.valid_until < now) {
    return err('TOKEN_EXPIRED', '令牌已过期，请重新激活', 401);
  }

  const rec = await getCode(env, payload.code);
  if (!rec) {
    return err('CODE_NOT_FOUND', '激活码记录不存在');
  }

  const revoked = rec.status === 'revoked';
  const latest_version = await getConfig(env, 'latest_version', '0.1.0');
  const min_version = await getConfig(env, 'min_version', '0.1.0');

  const resp: Record<string, unknown> = {
    latest_version,
    min_version,
    revoked,
  };

  const remainingDays = (payload.valid_until - now) / 86400;
  if (!revoked && remainingDays < RENEW_WINDOW_DAYS) {
    const newValidUntil = now + NEW_VALID_DAYS * 86400;
    const newToken = await signToken(
      {
        code: payload.code,
        machine_id: payload.machine_id,
        issued_at: now,
        valid_until: newValidUntil,
      },
      env.SIGNING_PRIVATE_KEY,
    );
    resp.new_token = newToken;
    resp.new_valid_until = new Date(newValidUntil * 1000).toISOString();
  }

  return ok(resp);
}
