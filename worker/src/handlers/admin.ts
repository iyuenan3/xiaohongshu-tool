import type {
  CodeRecord,
  Env,
  IssueCodesRequest,
  RebindRequest,
  RevokeRequest,
} from '../types';
import { generateCode } from '../crypto';
import { checkRate, getCode, putCode } from '../kv';
import { clientIp, err, ok, unixNow } from '../util';

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
  for (let i = 0; i < quantity; i++) {
    let code = generateCode();
    let retry = 0;
    while (await getCode(env, code)) {
      if (++retry > 5) return err('INTERNAL', 'code collision after 5 retries', 500);
      code = generateCode();
    }
    const rec: CodeRecord = {
      status: 'unused',
      bound_machine_id: null,
      bound_at: null,
      expire_at,
      rebind_count: 0,
      notes: body.notes ?? '',
      revoked_reason: null,
    };
    await putCode(env, code, rec);
    codes.push(code);
  }
  return ok({ codes });
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

  rec.status = 'revoked';
  rec.revoked_reason = body.reason ?? null;
  await putCode(env, body.code, rec);
  return ok({ revoked_code: body.code });
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

  rec.bound_machine_id = body.new_machine_id;
  rec.bound_at = unixNow();
  rec.rebind_count++;
  rec.status = 'active';
  await putCode(env, body.code, rec);
  return ok({ rebind_count: rec.rebind_count });
}
