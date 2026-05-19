// newapi (QuantumNous/new-api) admin API client
// 仅管理 xhs-* 前缀资源, 所有写操作前 assertXhsTenant 护栏验证 (§12.10.13 多租户隔离)

import type { Env } from './types';

interface NewApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
}

function adminHeaders(env: Env, userIdOverride?: number): HeadersInit {
  return {
    Authorization: `Bearer ${env.NEW_API_ACCESS_TOKEN}`,
    'New-Api-User': String(userIdOverride ?? env.NEW_API_USER_ID),
    'Content-Type': 'application/json',
  };
}

async function call<T = unknown>(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
  userIdOverride?: number,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: adminHeaders(env, userIdOverride),
  };
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = JSON.stringify(body);
  }
  const resp = await fetch(`${env.NEW_API_BASE_URL}${path}`, init);
  const text = await resp.text();
  let json: NewApiResponse<T>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`newapi non-JSON response (${resp.status}): ${text.slice(0, 200)}`);
  }
  if (!json.success) {
    throw new Error(`newapi ${method} ${path} failed: ${json.message || 'unknown'}`);
  }
  return json.data as T;
}

// ============ user ============

interface NewApiUser {
  id: number;
  username: string;
  display_name: string;
  group: string;
  status: number;
}

export async function createUser(
  env: Env,
  args: { username: string; password: string; display_name: string },
): Promise<NewApiUser> {
  return call<NewApiUser>(env, 'POST', '/api/user/', args);
}

export async function getUser(env: Env, userId: number): Promise<NewApiUser> {
  return call<NewApiUser>(env, 'GET', `/api/user/${userId}`);
}

export async function deleteUser(env: Env, userId: number): Promise<void> {
  await call(env, 'DELETE', `/api/user/${userId}`);
}

// ============ token ============

interface NewApiToken {
  id: number;
  key: string;          // sk-xxx 完整 (创建时返回, list 时是 masked)
  name: string;
  status: number;       // 1=enabled, 2=disabled
  user_id: number;
  group: string;
  unlimited_quota: boolean;
  remain_quota: number;
  used_quota: number;
  model_limits_enabled: boolean;
  model_limits: string;
  expired_time: number;
}

export async function createToken(
  env: Env,
  userId: number,
  args: {
    name: string;
    unlimited_quota: boolean;
    model_limits_enabled: boolean;
    model_limits: string;
    expired_time: number;
    group: string;
  },
): Promise<NewApiToken> {
  return call<NewApiToken>(env, 'POST', '/api/token/', args, userId);
}

export async function getToken(env: Env, tokenId: number): Promise<NewApiToken> {
  return call<NewApiToken>(env, 'GET', `/api/token/${tokenId}`);
}

// newapi 没有单独 enable/disable 端点, 必须用 PUT /api/token/ 全量更新
// 先 GET 拿当前状态 + 改 status + PUT 回去
export async function updateTokenStatus(env: Env, tokenId: number, status: 1 | 2): Promise<void> {
  const token = await getToken(env, tokenId);
  await call(env, 'PUT', '/api/token/', { ...token, status }, token.user_id);
}

export async function deleteToken(env: Env, tokenId: number): Promise<void> {
  await call(env, 'DELETE', `/api/token/${tokenId}`);
}

// ============ subscription ============

interface NewApiUserSubscription {
  id: number;
  user_id: number;
  plan_id: number;
  status: number;
  amount_total: number;
  amount_used: number;
  next_reset_time: number;
}

export async function bindSubscription(
  env: Env,
  userId: number,
  planId: number,
): Promise<NewApiUserSubscription> {
  return call<NewApiUserSubscription>(
    env,
    'POST',
    `/api/subscription/admin/users/${userId}/subscriptions`,
    { plan_id: planId },
  );
}

export async function getUserSubscriptions(
  env: Env,
  userId: number,
): Promise<NewApiUserSubscription[]> {
  return call<NewApiUserSubscription[]>(
    env,
    'GET',
    `/api/subscription/admin/users/${userId}/subscriptions`,
  );
}

export async function invalidateSubscription(
  env: Env,
  userSubId: number,
): Promise<void> {
  await call(env, 'POST', `/api/subscription/admin/user_subscriptions/${userSubId}/invalidate`);
}

// ============ status (汇率/单位, 启动时拉一次缓存可选) ============

interface NewApiStatus {
  quota_per_unit: number;       // 500000 ($1 raw 单位)
  usd_exchange_rate: number;    // 7.3 (CNY/USD)
}

export async function getStatus(env: Env): Promise<NewApiStatus> {
  // Cloudflare Workers fetch 自带 edge cache, 同样 URL 60s 内 dedupe
  return call<NewApiStatus>(env, 'GET', '/api/status');
}

// ============ 多租户隔离护栏 (§12.10.13) ============

/**
 * 任何 newapi 写操作 (suspend/resume/revoke/delete) 前必须调用。
 * 验证目标 user.username 以 `xhs-` 开头, 拒绝越权操作其他租户 (lijunfeng / maxwell 等)。
 *
 * @throws Error('TENANT_VIOLATION: ...') 如果不是 xhs 租户
 */
export async function assertXhsTenant(env: Env, userId: number): Promise<void> {
  const user = await getUser(env, userId);
  if (!user.username || !user.username.startsWith('xhs-')) {
    throw new Error(
      `TENANT_VIOLATION: refuse operation on user_id=${userId} (username='${user.username}'), not xhs tenant`,
    );
  }
}
