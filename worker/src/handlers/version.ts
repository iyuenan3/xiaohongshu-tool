import type { Env } from '../types';
import { getConfig, checkRate } from '../kv';
import { clientIp, ok, err } from '../util';

// Public 端点, 客户端启动后调一次. 无 auth.
// 默认 fallback 走 KV config: latest_version / min_version / support_contact / release_notes
// 通过 wrangler kv key put / Admin CLI 或 KV UI 改值, 不需要重新 deploy
export async function handleVersion(req: Request, env: Env): Promise<Response> {
  const ip = clientIp(req);
  // 60/min, 防恶意刷
  if (!(await checkRate(env, ip, 'version', 60))) {
    return err('RATE_LIMITED', 'too many version checks', 429);
  }

  const latest_version = await getConfig(env, 'latest_version', '0.3.1');
  const min_version = await getConfig(env, 'min_version', '0.1.0');
  const support_contact = await getConfig(
    env,
    'support_contact',
    '微信: maxwellii (添加好友请备注「小红书自运营」)',
  );
  const release_notes = await getConfig(env, 'release_notes', '');

  return ok({
    latest_version,
    min_version,
    support_contact,
    release_notes,
  });
}
