import type { Env } from './types';
import { handleActivate } from './handlers/activate';
import { handleHeartbeat } from './handlers/heartbeat';
import { handleAdminCodes, handleAdminRevoke, handleAdminRebind, handleAdminList } from './handlers/admin';
import { handleVersion } from './handlers/version';
import { ADMIN_HTML } from './admin-ui';
import { err } from './util';

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;

    try {
      switch (route) {
        case 'POST /activate':
          return await handleActivate(req, env);
        case 'POST /heartbeat':
          return await handleHeartbeat(req, env);
        case 'GET /version':
          return await handleVersion(req, env);
        case 'POST /admin/codes':
          return await handleAdminCodes(req, env);
        case 'GET /admin/codes':
          return await handleAdminList(req, env);
        case 'POST /admin/revoke':
          return await handleAdminRevoke(req, env);
        case 'POST /admin/rebind':
          return await handleAdminRebind(req, env);
        case 'GET /':
          return new Response(
            JSON.stringify({ ok: true, service: 'xhs-license', version: '0.1.0' }),
            { headers: { 'content-type': 'application/json; charset=utf-8' } },
          );
        case 'GET /admin':
          return new Response(ADMIN_HTML, {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
      }
      return err('NOT_FOUND', `Route not found: ${route}`, 404);
    } catch (e) {
      console.error('[handler error]', e);
      return err('INTERNAL', String(e), 500);
    }
  },
} satisfies ExportedHandler<Env>;
