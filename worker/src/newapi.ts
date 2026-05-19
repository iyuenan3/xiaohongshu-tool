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

// newapi POST 创建端点 (user/token/subscription) 统一返 {success, message} 不返 data,
// 必须 follow-up GET search/list 拿 id. helpers 抽象 paginated search 响应.
interface PageResult<T> {
  items: T[];
  total: number;
  page?: number;
  page_size?: number;
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
  // POST /api/user/ 不返 data, follow-up GET /api/user/search?keyword=<username> 拿 id
  await call<unknown>(env, 'POST', '/api/user/', args);
  const search = await call<PageResult<NewApiUser>>(
    env,
    'GET',
    `/api/user/search?keyword=${encodeURIComponent(args.username)}`,
  );
  const found = search.items?.find((u) => u.username === args.username);
  if (!found) {
    throw new Error(`createUser POST ok but search miss: username='${args.username}'`);
  }
  return found;
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

// /api/token/ 端点是 UserAuth (不是 AdminAuth), 严格校验 Bearer 用户 id === New-Api-User header,
// admin token 不能代用户操作. 必须 user 自己用 username+password 登录拿 session cookie 后调用.
async function loginUser(
  env: Env,
  username: string,
  password: string,
): Promise<{ userId: number; cookieHeader: string }> {
  const resp = await fetch(`${env.NEW_API_BASE_URL}/api/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  // 取 Set-Cookie name=value 部分 (CF Workers Response.headers.get('set-cookie') 已合并多 cookie)
  const setCookie = resp.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error(`newapi login: no Set-Cookie returned (status=${resp.status})`);
  }
  // setCookie 形如 "session=abc123; Path=/; HttpOnly, other=xxx; Path=/"
  // 拼回 Cookie header (只取 name=value, 丢 Path/HttpOnly/Expires 等属性)
  const cookieHeader = setCookie
    .split(/,(?=\s*\w+=)/) // split by ", " before next name= (避开 Expires 里的 ,)
    .map((c) => c.trim().split(';')[0])
    .filter(Boolean)
    .join('; ');
  if (!cookieHeader) {
    throw new Error(`newapi login: cannot parse cookie from '${setCookie.slice(0, 200)}'`);
  }
  const text = await resp.text();
  let json: NewApiResponse<{ id: number }>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`newapi login non-JSON (${resp.status}): ${text.slice(0, 200)}`);
  }
  if (!json.success || !json.data) {
    throw new Error(`newapi login failed: ${json.message || 'unknown'}`);
  }
  return { userId: json.data.id, cookieHeader };
}

async function callAsUser<T = unknown>(
  env: Env,
  cookieHeader: string,
  userId: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      Cookie: cookieHeader,
      'New-Api-User': String(userId),
      'Content-Type': 'application/json',
    },
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
    throw new Error(`newapi ${method} ${path} (as user ${userId}) failed: ${json.message || 'unknown'}`);
  }
  return json.data as T;
}

export async function createToken(
  env: Env,
  userId: number,
  password: string,
  args: {
    name: string;
    unlimited_quota: boolean;
    model_limits_enabled: boolean;
    model_limits: string;
    expired_time: number;
    group: string;
  },
): Promise<NewApiToken> {
  // user-scoped 端点必须 user 自己登录后调, admin 不能代操作 (newapi UserAuth 严格)
  const { cookieHeader } = await loginUser(env, args.name, password);

  // POST 创建 (不返 data)
  await callAsUser<unknown>(env, cookieHeader, userId, 'POST', '/api/token/', args);

  // follow-up GET search 拿 token id (masked)
  const search = await callAsUser<PageResult<NewApiToken>>(
    env,
    cookieHeader,
    userId,
    'GET',
    `/api/token/search?keyword=${encodeURIComponent(args.name)}`,
  );
  const found = search.items?.find((t) => t.name === args.name);
  if (!found) {
    throw new Error(`createToken POST ok but search miss: name='${args.name}', user_id=${userId}`);
  }

  // POST /:id/key 拿完整 sk-xxx
  const keyResp = await callAsUser<{ key: string }>(
    env,
    cookieHeader,
    userId,
    'POST',
    `/api/token/${found.id}/key`,
    {},
  );
  return { ...found, key: keyResp.key };
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
  status: string;   // active / expired / invalidated (string, 不是 number)
  amount_total: number;
  amount_used: number;
  next_reset_time: number;
}

// GET /users/:id/subscriptions 返 []SubscriptionSummary, 每项是 {subscription: UserSubscription} 包一层
interface SubscriptionSummary {
  subscription: NewApiUserSubscription;
}

export async function bindSubscription(
  env: Env,
  userId: number,
  planId: number,
): Promise<NewApiUserSubscription> {
  // POST 不返 data (返 null 或 {message: ...}), follow-up GET list 找最新 plan_id 匹配 (取最大 id)
  await call<unknown>(
    env,
    'POST',
    `/api/subscription/admin/users/${userId}/subscriptions`,
    { plan_id: planId },
  );
  const subs = await getUserSubscriptions(env, userId);
  const matches = subs.filter((s) => s.plan_id === planId);
  if (matches.length === 0) {
    throw new Error(`bindSubscription POST ok but list miss: plan_id=${planId}, user_id=${userId}`);
  }
  return matches.reduce((a, b) => (a.id > b.id ? a : b));
}

export async function getUserSubscriptions(
  env: Env,
  userId: number,
): Promise<NewApiUserSubscription[]> {
  const summaries = await call<SubscriptionSummary[]>(
    env,
    'GET',
    `/api/subscription/admin/users/${userId}/subscriptions`,
  );
  return (summaries ?? []).map((s) => s.subscription).filter((s) => s != null);
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
