import type { ActivateRequest, Env, LlmConfig } from '../types';
import { decryptApiKey, isValidCode, signToken } from '../crypto';
import { checkRate, getCode, putCode } from '../kv';
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

  // v0.6 D6: 状态过滤, 防止 suspended/revoked 码清重装绕过
  if (rec.status === 'revoked') {
    return err('CODE_REVOKED', '此激活码已停用，请联系客服');
  }
  if (rec.status === 'suspended') {
    return err('CODE_SUSPENDED', 'AI 服务已暂停，请联系客服续费 LLM 服务');
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

  // v0.6 D6: 下发 LLM 配置 (api_key 从 KV decrypt)
  let llm: LlmConfig | null = null;
  if (rec.api_key_encrypted) {
    try {
      const apiKey = await decryptApiKey(rec.api_key_encrypted, env.SIGNING_PRIVATE_KEY);
      llm = {
        base_url: env.XHS_LLM_BASE_URL,
        api_key: apiKey,
        model: 'auto-llm',
      };
    } catch (e) {
      console.warn(`[activate] decrypt api_key failed for ${body.code}: ${e}`);
      // llm 保持 null, 客户端 dialog "中转暂不可用, 暗号切 BYOK"
    }
  }

  return ok({
    token,
    valid_until: new Date(valid_until * 1000).toISOString(),
    status: rec.status,
    llm,
  });
}
