export interface Env {
  LICENSES: KVNamespace;
  SIGNING_PRIVATE_KEY: string;
  ADMIN_TOKEN: string;
}

export interface CodeRecord {
  status: 'unused' | 'active' | 'revoked';
  bound_machine_id: string | null;
  bound_at: number | null;
  expire_at: number | null;
  rebind_count: number;
  notes: string;
  revoked_reason: string | null;
}

export interface SignedTokenPayload {
  code: string;
  machine_id: string;
  issued_at: number;
  valid_until: number;
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

export type ErrorCode =
  | 'CODE_NOT_FOUND'
  | 'CODE_REVOKED'
  | 'CODE_BOUND_OTHER'
  | 'CODE_EXPIRED'
  | 'INVALID_TOKEN'
  | 'TOKEN_EXPIRED'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'INTERNAL';
