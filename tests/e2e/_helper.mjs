// Common helper for E2E tests
// Usage: import { connect, evalFn, sleep, makeReporter, ADMIN, WORKER, LICENSE } from './_helper.mjs'

export const CDP_URL = 'http://127.0.0.1:53759/json';
export const GO_BASE = 'http://127.0.0.1:54092';
export const WORKER = 'https://xhslicense.maxwellii.com';
export const ADMIN = 'LFW50BqUFVzJwqb/vqFoGPJqSEtlnx9wq/FY7vVBP8U=';
export const LICENSE = {
  code: 'XHS-7WXF-K9LR-3FLR-FQAG',
  machine_id: 'b4fabf11aa748f11bcfe03f28b08e13d8ec67ce05b97ca39f8150baab98d4a9a',
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Open CDP WebSocket connection to renderer + Runtime.enable.
 * Optionally ensure main UI is loaded (no activation card). Some tests
 * (e.g. license / IPC surface) only need preload bridge so they don't care.
 *
 * @param {object} opts
 * @param {boolean} opts.requireMainUI - if true, page.reload + wait for .tabbar
 * @param {number} opts.reloadTimeoutMs - max wait for tabbar after reload
 */
export async function connect({ requireMainUI = false, reloadTimeoutMs = 4000 } = {}) {
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
    let ready = await evalFn(`() => !!document.querySelector('.tabbar__tab')`);
    if (!ready) {
      // KNOWN BUG: license.status=active but UI stuck on activation page.
      // Reloading triggers a fresh mount that renders main UI correctly.
      await send('Page.reload', { ignoreCache: false });
      const t0 = Date.now();
      while (Date.now() - t0 < reloadTimeoutMs) {
        await sleep(250);
        ready = await evalFn(`() => !!document.querySelector('.tabbar__tab')`);
        if (ready) break;
      }
      if (!ready) {
        console.error('[fatal] requireMainUI: tabbar still missing after reload');
      }
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
