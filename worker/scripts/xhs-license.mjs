#!/usr/bin/env node
// 国内 DNS 劫持 workers.dev 时, 需通过 HTTPS_PROXY 代理 fetch
// (Node undici 不读 system proxy, 必须显式 ProxyAgent)
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxyUrl) {
  const { setGlobalDispatcher, ProxyAgent } = await import('undici');
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

// xhs-license admin CLI
// Usage:
//   xhs-license issue [-c COUNT] [-n "notes"] [-e YYYY-MM-DD]
//   xhs-license revoke CODE [-r "reason"]
//   xhs-license rebind CODE NEW_MACHINE_ID
//   xhs-license health
//
// Env:
//   WORKER_URL   default http://localhost:8787
//   ADMIN_TOKEN  required for admin commands

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8787';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const [, , cmd, ...args] = process.argv;

if (!cmd || cmd === '-h' || cmd === '--help') usage(0);
if (!ADMIN_TOKEN && cmd !== 'health') {
  console.error('Error: ADMIN_TOKEN env var required for admin commands\n');
  usage(1);
}

function usage(code = 1) {
  console.error(`xhs-license admin CLI

Usage:
  xhs-license issue [-c COUNT] [-n "notes"] [-e YYYY-MM-DD]
  xhs-license revoke CODE [-r "reason"]
  xhs-license rebind CODE NEW_MACHINE_ID
  xhs-license health

Env vars:
  WORKER_URL=${WORKER_URL}
  ADMIN_TOKEN=${ADMIN_TOKEN ? '(set)' : '(NOT SET)'}
`);
  process.exit(code);
}

function flag(name, def = undefined) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}
function positional(idx) {
  return args.filter((a, i) => !a.startsWith('-') && !(i > 0 && args[i - 1].startsWith('-')))[idx];
}

async function call(path, body, useAdmin = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (useAdmin) headers.Authorization = `Bearer ${ADMIN_TOKEN}`;
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return await res.json();
}

try {
  switch (cmd) {
    case 'issue': {
      const count = parseInt(flag('-c', '1'), 10);
      const notes = flag('-n', '');
      const expire = flag('-e', null);
      const body = { quantity: count, notes };
      if (expire) body.expire_at = `${expire}T23:59:59Z`;
      const r = await call('/admin/codes', body);
      if (!r.ok) {
        console.error(JSON.stringify(r, null, 2));
        process.exit(1);
      }
      console.error(`# ${count} code(s) issued${notes ? ' / notes: ' + notes : ''}`);
      r.codes.forEach((c) => console.log(c));
      break;
    }
    case 'revoke': {
      const code = positional(0);
      if (!code) {
        console.error('Usage: revoke CODE [-r REASON]');
        process.exit(2);
      }
      const reason = flag('-r', '');
      const r = await call('/admin/revoke', { code, reason });
      console.log(JSON.stringify(r, null, 2));
      if (!r.ok) process.exit(1);
      break;
    }
    case 'rebind': {
      const code = positional(0);
      const newMachineId = positional(1);
      if (!code || !newMachineId) {
        console.error('Usage: rebind CODE NEW_MACHINE_ID');
        process.exit(2);
      }
      const r = await call('/admin/rebind', { code, new_machine_id: newMachineId });
      console.log(JSON.stringify(r, null, 2));
      if (!r.ok) process.exit(1);
      break;
    }
    case 'health': {
      const res = await fetch(`${WORKER_URL}/`);
      const body = await res.json();
      console.log(JSON.stringify(body, null, 2));
      break;
    }
    default:
      usage(1);
  }
} catch (e) {
  console.error('Request failed:', e.message);
  process.exit(1);
}
