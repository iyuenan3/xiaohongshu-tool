import type {
  CodeRecord,
  Env,
  IssueCodesRequest,
  RebindRequest,
  RevokeRequest,
  SuspendRequest,
  ResumeRequest,
} from '../types';
import { encryptApiKey, generateCode } from '../crypto';
import { checkRate, getCode, putCode } from '../kv';
import { clientIp, err, ok, unixNow } from '../util';
import * as newapi from '../newapi';

function authorized(req: Request, env: Env): boolean {
  const auth = req.headers.get('authorization');
  return auth === `Bearer ${env.ADMIN_TOKEN}`;
}

async function adminGate(req: Request, env: Env): Promise<Response | null> {
  const ip = clientIp(req);
  if (!(await checkRate(env, ip, 'admin', 50))) {
    return err('RATE_LIMITED', 'too many admin requests', 429);
  }
  if (!authorized(req, env)) {
    return err('UNAUTHORIZED', 'missing or invalid ADMIN_TOKEN', 401);
  }
  return null;
}

/**
 * Build newapi resources for a code (3 steps, strong consistency rollback on any failure).
 * Returns { userId, subId, tokenId, apiKey } on success.
 */
async function provisionNewapiResources(
  env: Env,
  code: string,
): Promise<{ userId: number; subId: number; tokenId: number; apiKey: string }> {
  // username = "xhs-" + 激活码末 9 字符 (末两段含中间 dash) 小写
  // e.g. code "XHS-3KH8-7QM4-WX2A-BCDF" → "xhs-wx2a-bcdf" (13 字符 ≤ newapi max 20)
  const username = `xhs-${code.slice(-9).toLowerCase()}`;
  const displayName = `XHS-${code.slice(-4)}`;
  // 占位密码 (客户不登录 newapi UI), hex 前 20 字符
  const password = crypto.randomUUID().replace(/-/g, '').slice(0, 20);

  let userId: number | null = null;
  let subId: number | null = null;
  let tokenId: number | null = null;

  try {
    // Step 1: create user
    const user = await newapi.createUser(env, {
      username,
      password,
      display_name: displayName,
    });
    userId = user.id;

    // Step 2: bind XHS Plan subscription
    const sub = await newapi.bindSubscription(env, userId, parseInt(env.XHS_PLAN_ID, 10));
    subId = sub.id;

    // Step 3: create token (model_limits=auto-llm 锁死, expired_time=-1 永久)
    // newapi token 端点是 UserAuth 严格校验, admin 不能代操作, createToken 内部用 password 登录
    const token = await newapi.createToken(env, userId, password, {
      name: username,
      unlimited_quota: true,
      model_limits_enabled: true,
      model_limits: 'auto-llm',
      expired_time: -1,
      group: env.XHS_NEWAPI_GROUP,
    });
    tokenId = token.id;

    return { userId, subId, tokenId, apiKey: token.key };
  } catch (e) {
    // Strong consistency rollback (best-effort, ignore individual errors)
    if (tokenId !== null) {
      await newapi.deleteToken(env, tokenId).catch(() => {});
    }
    if (subId !== null) {
      await newapi.invalidateSubscription(env, subId).catch(() => {});
    }
    if (userId !== null) {
      await newapi.deleteUser(env, userId).catch(() => {});
    }
    throw e;
  }
}

export async function handleAdminCodes(req: Request, env: Env): Promise<Response> {
  const gate = await adminGate(req, env);
  if (gate) return gate;

  let body: IssueCodesRequest;
  try {
    body = (await req.json()) as IssueCodesRequest;
  } catch {
    return err('BAD_REQUEST', 'invalid JSON body');
  }
  const quantity = body?.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    return err('BAD_REQUEST', 'quantity must be integer 1..100');
  }

  let expire_at: number | null = null;
  if (body.expire_at) {
    const ts = Math.floor(new Date(body.expire_at).getTime() / 1000);
    if (!Number.isFinite(ts) || ts < unixNow()) {
      return err('BAD_REQUEST', 'expire_at invalid or already passed');
    }
    expire_at = ts;
  }

  const codes: string[] = [];
  const failures: Array<{ code: string; error: string }> = [];

  for (let i = 0; i < quantity; i++) {
    // 1. generate unique code (KV + newapi username collision avoidance via retry)
    let code: string;
    let kvRetry = 0;
    do {
      code = generateCode();
      if (++kvRetry > 5) {
        return err('INTERNAL', 'code collision in KV after 5 retries', 500);
      }
    } while (await getCode(env, code));

    // 2. provision newapi resources (3-step + rollback on failure)
    let provisioned;
    try {
      provisioned = await provisionNewapiResources(env, code);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // username DB UNIQUE collision: regenerate code + retry once
      if (msg.includes('username') || msg.includes('duplicate') || msg.includes('UNIQUE')) {
        try {
          code = generateCode();
          provisioned = await provisionNewapiResources(env, code);
        } catch (e2) {
          failures.push({ code, error: e2 instanceof Error ? e2.message : String(e2) });
          continue;
        }
      } else {
        failures.push({ code, error: msg });
        continue;
      }
    }

    // 3. encrypt api_key + write KV
    const apiKeyEncrypted = await encryptApiKey(provisioned.apiKey, env.SIGNING_PRIVATE_KEY);
    const rec: CodeRecord = {
      status: 'unused',
      bound_machine_id: null,
      bound_at: null,
      created_at: Math.floor(Date.now() / 1000),
      expire_at,
      rebind_count: 0,
      notes: body.notes ?? '',
      revoked_reason: null,
      newapi_user_id: provisioned.userId,
      newapi_sub_id: provisioned.subId,
      newapi_token_id: provisioned.tokenId,
      api_key_encrypted: apiKeyEncrypted,
      suspended_at: null,
      suspend_reason: null,
      resumed_at: null,
      revoked_at: null,
    };
    await putCode(env, code, rec);
    codes.push(code);
  }

  if (failures.length > 0 && codes.length === 0) {
    return err('NEWAPI_FAILED', `all ${quantity} codes failed: ${failures[0].error}`, 502);
  }
  return ok({ codes, failures: failures.length > 0 ? failures : undefined });
}

export async function handleAdminRevoke(req: Request, env: Env): Promise<Response> {
  const gate = await adminGate(req, env);
  if (gate) return gate;

  let body: RevokeRequest;
  try {
    body = (await req.json()) as RevokeRequest;
  } catch {
    return err('BAD_REQUEST', 'invalid JSON body');
  }
  if (!body?.code) return err('BAD_REQUEST', 'missing code');

  const rec = await getCode(env, body.code);
  if (!rec) return err('CODE_NOT_FOUND', 'no such code');

  // Multi-tenant safety (§12.10.13)
  if (rec.newapi_user_id !== null) {
    try {
      await newapi.assertXhsTenant(env, rec.newapi_user_id);
    } catch (e) {
      return err('TENANT_VIOLATION', e instanceof Error ? e.message : String(e), 403);
    }
    // 硬停: invalidate subscription + delete user (级联删 token), 不可逆.
    // 都 best-effort, newapi 不可达不阻塞 KV 状态写 (KV revoked 已能让 /activate 拒绝)
    if (rec.newapi_sub_id !== null) {
      await newapi.invalidateSubscription(env, rec.newapi_sub_id).catch((e) => {
        console.warn(`[revoke] invalidate sub failed: ${e}`);
      });
    }
    await newapi.deleteUser(env, rec.newapi_user_id).catch((e) => {
      console.warn(`[revoke] delete user failed: ${e}`);
    });
  }

  rec.status = 'revoked';
  rec.revoked_reason = body.reason ?? null;
  rec.revoked_at = new Date().toISOString();
  await putCode(env, body.code, rec);
  return ok({ revoked_code: body.code });
}

export async function handleAdminSuspend(req: Request, env: Env): Promise<Response> {
  const gate = await adminGate(req, env);
  if (gate) return gate;

  let body: SuspendRequest;
  try {
    body = (await req.json()) as SuspendRequest;
  } catch {
    return err('BAD_REQUEST', 'invalid JSON body');
  }
  if (!body?.code) return err('BAD_REQUEST', 'missing code');

  const rec = await getCode(env, body.code);
  if (!rec) return err('CODE_NOT_FOUND', 'no such code');

  if (rec.status !== 'active') {
    const hint: Record<string, string> = {
      unused: '激活码尚未被激活, 不能 suspend',
      suspended: '激活码已是 suspended 状态',
      revoked: '激活码已 revoked, 不可再 suspend (revoke 不可逆)',
    };
    return err('INVALID_STATE', `current=${rec.status}: ${hint[rec.status] ?? '未知'}`, 400);
  }

  // Multi-tenant safety
  if (rec.newapi_user_id !== null) {
    try {
      await newapi.assertXhsTenant(env, rec.newapi_user_id);
    } catch (e) {
      return err('TENANT_VIOLATION', e instanceof Error ? e.message : String(e), 403);
    }
  }

  // 软停: invalidate subscription (quota → 0, token 不动, 客户端调 LLM 自然 fail)
  // 用 admin 端点不需 user cookie. 失败要 abort 不写 KV, 保证状态一致
  if (rec.newapi_sub_id !== null) {
    try {
      await newapi.invalidateSubscription(env, rec.newapi_sub_id);
    } catch (e) {
      return err('NEWAPI_FAILED', `invalidate sub failed: ${e}`, 502);
    }
  }

  rec.status = 'suspended';
  rec.suspended_at = new Date().toISOString();
  rec.suspend_reason = body.reason ?? '未续 LLM 月费';
  await putCode(env, body.code, rec);
  return ok({ suspended_code: body.code });
}

export async function handleAdminResume(req: Request, env: Env): Promise<Response> {
  const gate = await adminGate(req, env);
  if (gate) return gate;

  let body: ResumeRequest;
  try {
    body = (await req.json()) as ResumeRequest;
  } catch {
    return err('BAD_REQUEST', 'invalid JSON body');
  }
  if (!body?.code) return err('BAD_REQUEST', 'missing code');

  const rec = await getCode(env, body.code);
  if (!rec) return err('CODE_NOT_FOUND', 'no such code');

  if (rec.status !== 'suspended') {
    const hint: Record<string, string> = {
      unused: '激活码尚未激活, 不能 resume',
      active: '激活码已是 active 状态, 无需 resume',
      revoked: '激活码已 revoked, 不可 resume (需重发新码)',
    };
    return err('INVALID_STATE', `current=${rec.status}: ${hint[rec.status] ?? '未知'}`, 400);
  }

  // Multi-tenant safety
  if (rec.newapi_user_id !== null) {
    try {
      await newapi.assertXhsTenant(env, rec.newapi_user_id);
    } catch (e) {
      return err('TENANT_VIOLATION', e instanceof Error ? e.message : String(e), 403);
    }
  }

  // 恢复: rebind XHS Plan 新建一个 user_subscription (满 quota, 月度自动 reset)
  // newapi 没"reactivate 旧 sub"端点, 只能新建. 新 sub_id 写回 KV
  if (rec.newapi_user_id !== null) {
    try {
      const newSub = await newapi.bindSubscription(
        env,
        rec.newapi_user_id,
        parseInt(env.XHS_PLAN_ID, 10),
      );
      rec.newapi_sub_id = newSub.id;
    } catch (e) {
      return err('NEWAPI_FAILED', `rebind sub failed: ${e}`, 502);
    }
  }

  rec.status = 'active';
  rec.suspended_at = null;
  rec.suspend_reason = null;
  rec.resumed_at = new Date().toISOString();
  await putCode(env, body.code, rec);
  return ok({ resumed_code: body.code });
}

export async function handleAdminList(req: Request, env: Env): Promise<Response> {
  const gate = await adminGate(req, env);
  if (gate) return gate;

  const url = new URL(req.url);
  const statusFilter = url.searchParams.get('status');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '500', 10), 1000);
  const search = url.searchParams.get('machine_id');

  const list = await env.LICENSES.list({ prefix: 'code:', limit });
  const codes: Array<CodeRecord & { code: string }> = [];
  for (const k of list.keys) {
    const raw = await env.LICENSES.get(k.name);
    if (!raw) continue;
    const rec = JSON.parse(raw) as CodeRecord;
    if (statusFilter && rec.status !== statusFilter) continue;
    if (search && (rec.bound_machine_id ?? '').indexOf(search) < 0) continue;
    codes.push({ ...rec, code: k.name.slice('code:'.length) });
  }
  return ok({ count: codes.length, list_complete: list.list_complete, codes });
}

export async function handleAdminOverdue(req: Request, env: Env): Promise<Response> {
  const gate = await adminGate(req, env);
  if (gate) return gate;

  // 列所有 suspended 超过 15 天的码, 帮 Maxwell 巡检 (人工 revoke 决定权)
  const FIFTEEN_DAYS_MS = 15 * 24 * 3600 * 1000;
  const now = Date.now();
  const list = await env.LICENSES.list({ prefix: 'code:', limit: 1000 });
  const overdue: Array<CodeRecord & { code: string; days_suspended: number }> = [];
  for (const k of list.keys) {
    const raw = await env.LICENSES.get(k.name);
    if (!raw) continue;
    const rec = JSON.parse(raw) as CodeRecord;
    if (rec.status !== 'suspended' || !rec.suspended_at) continue;
    const elapsed = now - new Date(rec.suspended_at).getTime();
    if (elapsed >= FIFTEEN_DAYS_MS) {
      overdue.push({
        ...rec,
        code: k.name.slice('code:'.length),
        days_suspended: Math.floor(elapsed / (24 * 3600 * 1000)),
      });
    }
  }
  return ok({ count: overdue.length, codes: overdue });
}

export async function handleAdminRebind(req: Request, env: Env): Promise<Response> {
  const gate = await adminGate(req, env);
  if (gate) return gate;

  let body: RebindRequest;
  try {
    body = (await req.json()) as RebindRequest;
  } catch {
    return err('BAD_REQUEST', 'invalid JSON body');
  }
  if (!body?.code || !body?.new_machine_id) {
    return err('BAD_REQUEST', 'missing code or new_machine_id');
  }
  if (body.new_machine_id.length < 8 || body.new_machine_id.length > 128) {
    return err('BAD_REQUEST', 'invalid new_machine_id');
  }

  const rec = await getCode(env, body.code);
  if (!rec) return err('CODE_NOT_FOUND', 'no such code');

  // 拒绝 suspended/revoked 状态 rebind (LLM 也没法用, 先 resume/重发)
  if (rec.status === 'suspended' || rec.status === 'revoked') {
    return err('INVALID_STATE', `cannot rebind code in status=${rec.status}`, 400);
  }

  rec.bound_machine_id = body.new_machine_id;
  rec.bound_at = unixNow();
  rec.rebind_count++;
  rec.status = 'active';
  await putCode(env, body.code, rec);
  return ok({ rebind_count: rec.rebind_count });
}
