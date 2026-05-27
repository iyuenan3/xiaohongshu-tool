// Common helper for E2E tests
// Usage: import { connect, evalFn, sleep, makeReporter, ADMIN, WORKER, LICENSE } from './_helper.mjs'

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

// CDP port 每次 dev 重启都变。优先从 dev 日志动态读 (见 portsFromDevLog),
// 下面的硬编码列表仅作 fallback (日志不可读时)。
export const CDP_PORT_CANDIDATES = [52705, 51121, 64818, 60334, 53759];
export const GO_BASE = 'http://127.0.0.1:54092';
// license 服务 base: 可用 env XHS_LICENSE_BASE 覆盖, 默认空。
export const WORKER = process.env.XHS_LICENSE_BASE || '';
// admin token 高敏感: 只从环境变量读, 绝不硬编码进 git。缺失时 admin 类测试 skip。
export const ADMIN = process.env.XHS_ADMIN_TOKEN || '';
// 本机激活码 / machine_id: 默认空 → license.mjs runtime 从 status() 兜底
// (不把激活凭证写进 git); 也可用 env 显式指定。
export const LICENSE = {
  code: process.env.XHS_LICENSE_CODE || '',
  machine_id: process.env.XHS_MACHINE_ID || '',
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 从 dev 日志读最近启动的 CDP 端口。dev 每次重启端口随机,
 * main.log 里有 "picked remote-debugging-port=N", 最新一次在文件末尾。
 */
function portsFromDevLog() {
  try {
    const log = readFileSync(`${homedir()}/Library/Logs/xhs-app/main.log`, 'utf8');
    const ports = [...log.matchAll(/picked remote-debugging-port=(\d+)/g)].map((m) => Number(m[1]));
    return ports.reverse(); // 最新重启的端口优先
  } catch {
    return [];
  }
}

/**
 * Probe CDP candidates and return the first one that responds.
 * 先试 dev 日志里最近的端口 (免手动维护), 再 fallback 到硬编码候选。
 */
async function probeCdpPort() {
  const seen = new Set();
  const candidates = [...portsFromDevLog(), ...CDP_PORT_CANDIDATES].filter((p) => !seen.has(p) && seen.add(p));
  for (const port of candidates) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json`, {
        signal: AbortSignal.timeout(800),
      });
      if (r.ok) return port;
    } catch {}
  }
  return null;
}

/**
 * Open CDP WebSocket connection to renderer + Runtime.enable.
 * Optionally ensure main UI is loaded (no activation card). Some tests
 * (e.g. license / IPC surface) only need preload bridge so they don't care.
 *
 * v0.2 (B-001 fixed): when requireMainUI is set we just *wait* for `.tabbar__tab`
 * to appear within `mainUiTimeoutMs`. The renderer pushes license state via
 * `license:changed` IPC, so the activation page should clear automatically. We
 * never call Page.reload anymore — the previous reload workaround was masking
 * the original bug.
 *
 * @param {object} opts
 * @param {boolean} opts.requireMainUI - if true, wait for .tabbar__tab
 * @param {number} opts.mainUiTimeoutMs - max wait time (default 5000ms)
 */
export async function connect({ requireMainUI = false, mainUiTimeoutMs = 5000 } = {}) {
  const port = await probeCdpPort();
  if (!port) {
    console.error(`[fatal] no CDP candidate responded (tried ${CDP_PORT_CANDIDATES.join(', ')})`);
    process.exit(2);
  }
  const CDP_URL = `http://127.0.0.1:${port}/json`;
  let targets;
  try {
    targets = await (await fetch(CDP_URL)).json();
  } catch (e) {
    console.error(`[fatal] cannot reach CDP ${CDP_URL}: ${e.message}`);
    process.exit(2);
  }
  const renderer = targets.find(
    (t) =>
      t.type === 'page' &&
      (t.url.startsWith('http://localhost:5173') ||
        t.url.startsWith('http://localhost:5174') ||
        t.url.startsWith('http://localhost:5175')),
  );
  if (!renderer) {
    console.error('[fatal] renderer page not found in CDP targets');
    process.exit(2);
  }
  const ws = new WebSocket(renderer.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    }
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', (e) => rej(new Error(e.message || 'ws error')), { once: true });
  });
  await send('Runtime.enable');
  await send('Page.enable');

  async function evalFn(fnSrc) {
    const expression = `(${fnSrc})()`;
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const msg = r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '');
      throw new Error(`Runtime exception: ${msg}`);
    }
    return r.result?.value;
  }

  if (requireMainUI) {
    // Wait for .tabbar__tab to appear (no reload). The renderer mounts, calls
    // license.status() async, then sets state → main UI renders. Also the
    // main process pushes `license:changed` for any state mutation.
    let ready = await evalFn(`() => !!document.querySelector('.tabbar__tab')`);
    const t0 = Date.now();
    while (!ready && Date.now() - t0 < mainUiTimeoutMs) {
      await sleep(100);
      ready = await evalFn(`() => !!document.querySelector('.tabbar__tab')`);
    }
    if (!ready) {
      console.error(`[fatal] requireMainUI: .tabbar__tab not appeared within ${mainUiTimeoutMs}ms`);
      process.exit(2);
    }
  }
  return { ws, send, evalFn, renderer };
}

export function makeReporter(moduleName) {
  let pass = 0;
  let fail = 0;
  let skip = 0;
  const failures = [];
  function ok(cond, msg, detail) {
    if (cond) {
      console.log(`  ✓ ${msg}`);
      pass++;
    } else {
      console.log(`  ✗ ${msg}`);
      if (detail !== undefined) console.log(`    detail: ${trunc(JSON.stringify(detail), 400)}`);
      fail++;
      failures.push({ msg, detail });
    }
  }
  function skipFn(msg, reason) {
    console.log(`  ~ SKIP ${msg}${reason ? ` (${reason})` : ''}`);
    skip++;
  }
  function summary(closer) {
    console.log(
      `\n=== ${moduleName} · pass ${pass} · fail ${fail} · skip ${skip} ===`,
    );
    closer && closer();
    process.exit(fail > 0 ? 1 : 0);
  }
  function stats() {
    return { module: moduleName, pass, fail, skip, failures };
  }
  return { ok, skip: skipFn, summary, stats };
}

// Safe stringify for circular/giant payloads
export function trunc(s, n = 200) {
  if (typeof s !== 'string') s = JSON.stringify(s);
  if (typeof s !== 'string') return String(s);
  return s.length > n ? s.slice(0, n) + '...' : s;
}

/**
 * Try a list of public image URLs until one returns 200 with image/* MIME.
 * Caller can pass into evalFn to test importUrl. Returns the picked URL or null.
 */
export async function pickReachableImageUrl() {
  const candidates = [
    'https://picsum.photos/seed/e2e/200/200',
    'https://www.gstatic.com/webp/gallery/1.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/120px-Cat03.jpg',
    'https://httpbin.org/image/jpeg',
  ];
  for (const u of candidates) {
    try {
      const ctrl = AbortSignal.timeout(5000);
      const r = await fetch(u, { method: 'HEAD', signal: ctrl });
      if (r.ok && (r.headers.get('content-type') || '').startsWith('image/')) return u;
    } catch {}
  }
  return null;
}
