import type { Env } from '../types';
import { derivePublicKey, isValidCode, verifyToken } from '../crypto';
import { checkRate, getCode } from '../kv';
import { clientIp, err, ok } from '../util';
import * as newapi from '../newapi';

/**
 * GET /quota?code=XHS-...&sig=<token>
 *
 * 客户端中转查 subscription quota。
 * sig = 激活时拿到的 SignedToken (用 Ed25519 验签防恶意第三方查别人配额)。
 */
export async function handleQuota(req: Request, env: Env): Promise<Response> {
  const ip = clientIp(req);
  if (!(await checkRate(env, ip, 'quota', 60))) {
    return err('RATE_LIMITED', 'too many quota queries', 429);
  }

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const sig = url.searchParams.get('sig');
  if (!code || !sig) return err('BAD_REQUEST', 'missing code or sig');
  if (!isValidCode(code)) return err('CODE_NOT_FOUND', '激活码格式错误');

  // verify sig (= 激活时拿到的 SignedToken 完整字符串)
  const publicKey = await derivePublicKey(env.SIGNING_PRIVATE_KEY);
  const payload = await verifyToken(sig, publicKey);
  if (!payload) return err('INVALID_TOKEN', 'sig 无效');
  if (payload.code !== code) return err('INVALID_TOKEN', 'sig 跟 code 不匹配');

  const rec = await getCode(env, code);
  if (!rec) return err('CODE_NOT_FOUND', '激活码不存在');
  if (rec.newapi_user_id === null || rec.newapi_sub_id === null) {
    return err('NEWAPI_FAILED', 'LLM 资源未配置', 503);
  }

  // 多租户隔离 (§12.10.13)
  try {
    await newapi.assertXhsTenant(env, rec.newapi_user_id);
  } catch (e) {
    return err('TENANT_VIOLATION', e instanceof Error ? e.message : String(e), 403);
  }

  // 拉 subscription quota + 实时汇率/单位
  let subs, status;
  try {
    [subs, status] = await Promise.all([
      newapi.getUserSubscriptions(env, rec.newapi_user_id),
      newapi.getStatus(env),
    ]);
  } catch (e) {
    return err('NEWAPI_FAILED', `newapi unreachable: ${e}`, 502);
  }

  const xhsSub = subs.find((s) => s.id === rec.newapi_sub_id);
  if (!xhsSub) return err('NEWAPI_FAILED', 'XHS subscription not found', 502);

  const QUOTA_PER_UNIT = status.quota_per_unit;
  const USD_EXCHANGE_RATE = status.usd_exchange_rate;
  const rawToCny = (raw: number) => (raw / QUOTA_PER_UNIT) * USD_EXCHANGE_RATE;

  return ok({
    remain_cny: rawToCny(xhsSub.amount_total - xhsSub.amount_used),
    total_cny: rawToCny(xhsSub.amount_total),
    used_cny: rawToCny(xhsSub.amount_used),
    next_reset_at: xhsSub.next_reset_time,
  });
}
