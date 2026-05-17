// IPC 表面完整性 E2E tests
// 列出 preload 暴露的所有 window.api.* 路径, 验证存在 + 部分可调
import { connect, makeReporter } from './_helper.mjs';

const { evalFn, ws } = await connect();
const r = makeReporter('IPC Surface');

console.log('=== E2E IPC Surface ===\n');

// 期望的 IPC 表面 (来自 preload/index.ts 契约)
const expectedSurface = {
  '': ['ping', 'getVersion', 'goStatus', 'goApi', 'openXhsWindow', 'getPageContext'],
  'conv': ['list', 'get', 'create', 'saveMessages', 'setTitle', 'delete', 'clearMessages'],
  'rate': ['check', 'log'],
  'updater': ['check'],
  'license': ['status', 'getMachineId', 'activate', 'heartbeat', 'clear'],
  'assets': ['pick', 'importUrl', 'list', 'delete', 'getPath', 'touchUsed', 'setTags', 'search'],
  'web': ['search'],
};

try {
  // IPC-01: window.api 暴露
  const hasApi = await evalFn(`() => typeof window.api === 'object' && window.api !== null`);
  r.ok(hasApi === true, `IPC-01 window.api 暴露`);

  // IPC-02 ~ IPC-10: 逐一检查每个路径
  for (const [namespace, fns] of Object.entries(expectedSurface)) {
    for (const fn of fns) {
      const path = namespace ? `window.api.${namespace}.${fn}` : `window.api.${fn}`;
      const isFunc = await evalFn(`() => typeof ${path} === 'function'`);
      r.ok(isFunc === true, `IPC: ${namespace || 'root'}.${fn} 是 function`, { path });
    }
  }

  // IPC-11: ping
  const pingRes = await evalFn(`async () => {
    try { return { ok: true, r: await window.api.ping() }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(pingRes.ok && pingRes.r !== undefined, `IPC-11 ping 返回非 undefined`, pingRes);

  // IPC-12: getVersion
  const ver = await evalFn(`async () => await window.api.getVersion()`);
  r.ok(typeof ver === 'string' && ver.length > 0, `IPC-12 getVersion 返回字符串`, ver);

  // IPC-13: goStatus
  const goSt = await evalFn(`async () => await window.api.goStatus()`);
  r.ok(goSt?.ok === true, `IPC-13 goStatus ok=true`, goSt);
  r.ok(typeof goSt?.baseUrl === 'string' && goSt.baseUrl.startsWith('http://'), `IPC-13b baseUrl 是 http:// URL`, goSt?.baseUrl);

  // IPC-14: goApi GET /health
  const healthRes = await evalFn(`async () => {
    try { return { ok: true, r: await window.api.goApi('GET', '/health', {}) }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(healthRes.ok, `IPC-14 goApi GET /health 调通`, healthRes);
  // 各种 Go 路径结构都可能, 至少不抛错
  r.ok(healthRes.r !== undefined, `IPC-14b goApi 返非 undefined`, healthRes.r);

  // IPC-15: getPageContext
  const ctx = await evalFn(`async () => {
    try { return { ok: true, r: await window.api.getPageContext() }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(ctx.ok, `IPC-15 getPageContext 不抛`, ctx);
  // 可以是 null 或 {url, title, text}
  if (ctx.r !== null && ctx.r !== undefined) {
    r.ok(
      typeof ctx.r?.url === 'string' && typeof ctx.r?.title === 'string' && typeof ctx.r?.text === 'string',
      `IPC-15b getPageContext 结构 {url,title,text} 都是 string`,
      { url: ctx.r?.url?.slice(0, 80), title: ctx.r?.title?.slice(0, 50) },
    );
  } else {
    r.ok(true, `IPC-15b getPageContext 返 null (无活动页) 也允许`);
  }
} catch (e) {
  r.ok(false, `运行时异常`, e.message);
}

r.summary(() => ws.close());
