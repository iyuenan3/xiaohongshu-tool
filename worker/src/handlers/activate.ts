import type { ActivateRequest, Env } from '../types';
import { signToken, isValidCode } from '../crypto';
import { getCode, putCode, checkRate } from '../kv';
import { clientIp, err, ok, unixNow } from '../util';

const VALID_DAYS = 365;

export async function handleActivate(req: Request, env: Env): Promise<Response> {
  const ip = clientIp(req);
  if (!(await checkRate(env, ip, 'activate', 10))) {
    return err('RATE_LIMITED', 'too many activation attempts', 429);
  }

  let body: ActivateRequest;
  try {
    body = (await req.json()) as ActivateRequest;
  } catch {
    return err('BAD_REQUEST', 'invalid JSON body');
  }
  if (!body?.code || !body?.machine_id) {
    return err('BAD_REQUEST', 'missing code or machine_id');
  }
  if (!isValidCode(body.code)) {
    return err('CODE_NOT_FOUND', '激活码格式错误');
  }
  if (body.machine_id.length < 8 || body.machine_id.length > 128) {
    return err('BAD_REQUEST', 'invalid machine_id');
  }

  const rec = await getCode(env, body.code);
  if (!rec) return err('CODE_NOT_FOUND', '激活码无效');
  if (rec.status === 'revoked') {
    return err('CODE_REVOKED', '此激活码已停用，请联系客服');
  }

  const now = unixNow();
  if (rec.expire_at && rec.expire_at < now) {
    return err('CODE_EXPIRED', '此激活码已过期');
  }

  if (rec.status === 'unused') {
    rec.status = 'active';
    rec.bound_machine_id = body.machine_id;
    rec.bound_at = now;
    await putCode(env, body.code, rec);
  } else {
    if (rec.bound_machine_id !== body.machine_id) {
      return err('CODE_BOUND_OTHER', '此激活码已绑定其他设备，请联系客服换绑');
    }
  }

  const valid_until = now + VALID_DAYS * 86400;
  const token = await signToken(
    {
      code: body.code,
      machine_id: body.machine_id,
      issued_at: now,
      valid_until,
    },
    env.SIGNING_PRIVATE_KEY,
  );

  return ok({
    token,
    valid_until: new Date(valid_until * 1000).toISOString(),
  });
}
