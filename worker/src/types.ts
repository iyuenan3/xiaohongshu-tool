export interface Env {
  LICENSES: KVNamespace;
  SIGNING_PRIVATE_KEY: string;
  ADMIN_TOKEN: string;
  // v0.6 D6 LLM Gateway 新增
  NEW_API_BASE_URL: string;       // https://llm.maxwellii.com (Worker 跨境用域名)
  NEW_API_ACCESS_TOKEN: string;   // maxwell access_token (system, 写权限)
  NEW_API_USER_ID: string;        // "1" (maxwell root user id, headers New-Api-User 用)
  XHS_PLAN_ID: string;            // "2" (XHS Plan id)
  XHS_NEWAPI_GROUP: string;       // "xhs"
  XHS_LLM_BASE_URL: string;       // https://139.196.157.57/v1 (客户端下发 base_url)
}

export type CodeStatus = 'unused' | 'active' | 'suspended' | 'revoked';

export interface CodeRecord {
  status: CodeStatus;
  bound_machine_id: string | null;
  bound_at: number | null;
  expire_at: number | null;
  rebind_count: number;
  notes: string;
  revoked_reason: string | null;
  // v0.6 D6 LLM 中转资源关联
  newapi_user_id: number | null;
  newapi_sub_id: number | null;
  newapi_token_id: number | null;
  api_key_encrypted: string | null;
  // v0.6 D6 suspend/resume 生命周期
  suspended_at: string | null;     // ISO timestamp
  suspend_reason: string | null;   // 仅运营内部, 客户端不展示
  resumed_at: string | null;
  revoked_at: string | null;
}

export interface SignedTokenPayload {
  code: string;
  machine_id: string;
  issued_at: number;
  valid_until: number;
}

export interface LlmConfig {
  base_url: string;
  api_key: string;
  model: string;
}

export interface ActivateRequest {
  code: string;
  machine_id: string;
}

export interface HeartbeatRequest {
  token: string;
}

export interface IssueCodesRequest {
  quantity: number;
  notes?: string;
  expire_at?: string;
}

export interface RevokeRequest {
  code: string;
  reason?: string;
}

export interface RebindRequest {
  code: string;
  new_machine_id: string;
}

// v0.6 D6 新增
export interface SuspendRequest {
  code: string;
  reason?: string;
}

export interface ResumeRequest {
  code: string;
}

export interface QuotaResponse {
  remain_cny: number;
  total_cny: number;
  used_cny: number;
  next_reset_at: number;   // unix ts
}

export type ErrorCode =
  | 'CODE_NOT_FOUND'
  | 'CODE_REVOKED'
  | 'CODE_SUSPENDED'        // v0.6 D6
  | 'CODE_BOUND_OTHER'
  | 'CODE_EXPIRED'
  | 'INVALID_TOKEN'
  | 'TOKEN_EXPIRED'
  | 'INVALID_STATE'         // v0.6 D6: suspend/resume 状态机错误
  | 'TENANT_VIOLATION'      // v0.6 D6: 多租户隔离 (assertXhsTenant 拒绝)
  | 'NEWAPI_FAILED'         // v0.6 D6: newapi 调用失败
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'INTERNAL';
