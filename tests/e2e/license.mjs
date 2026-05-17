// License module E2E tests
// 不调 license.clear() (会破坏 dev state)
import { connect, makeReporter, WORKER, ADMIN, LICENSE } from './_helper.mjs';

const { evalFn, ws } = await connect();
const r = makeReporter('License');

console.log('=== E2E License ===\n');

// LIC-01: status active
const status = await evalFn(`async () => await window.api.license.status()`);
r.ok(status?.status === 'active', `LIC-01 license.status() = active`, status);
r.ok(status?.code === LICENSE.code, `LIC-01b code 与文档一致`, status?.code);
r.ok(status?.machine_id === LICENSE.machine_id, `LIC-01c machine_id 与文档一致`, status?.machine_id);

// LIC-02: machineId
const mid = await evalFn(`async () => await window.api.license.getMachineId()`);
r.ok(typeof mid === 'string' && /^[0-9a-f]{64}$/.test(mid), `LIC-02 getMachineId 长度 64 hex`, mid);
r.ok(mid === status?.machine_id, `LIC-02b machineId 与 status.machine_id 相等`, { mid, mid2: status?.machine_id });

// LIC-03: heartbeat
let heartbeat;
try {
  heartbeat = await evalFn(`async () => await window.api.license.heartbeat()`);
  r.ok(heartbeat?.ok === true, `LIC-03 heartbeat ok=true`, heartbeat);
  r.ok(heartbeat?.revoked === false || heartbeat?.revoked === undefined, `LIC-03b revoked !== true`, heartbeat?.revoked);
} catch (e) {
  r.ok(false, `LIC-03 heartbeat threw`, e.message);
}

// LIC-04: 错的激活码 (调用 activate 前，要注意 active 状态下重新 activate 不一定能恢复)
// 改为只 dry-run: 我们用 worker /activate 直接调，不走 IPC, 避免污染 license.bin
try {
  const fakeRes = await fetch(`${WORKER}/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'invalid-code', machine_id: 'fake-machine-id' }),
  });
  const fakeJson = await fakeRes.json();
  r.ok(fakeJson?.ok === false, `LIC-04 错的激活码格式 worker 拒绝`, fakeJson);
} catch (e) {
  r.ok(false, `LIC-04 错的激活码 throw`, e.message);
}

// LIC-05: 不存在的激活码 (格式对)
try {
  const fakeRes = await fetch(`${WORKER}/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'XHS-XXXX-XXXX-XXXX-XXXX', machine_id: 'never-existed-machine' }),
  });
  const fakeJson = await fakeRes.json();
  r.ok(fakeJson?.ok === false, `LIC-05 不存在的码 worker 拒绝 ok=false`, fakeJson);
  r.ok(typeof fakeJson?.message === 'string' && fakeJson.message.length > 0, `LIC-05b 错误码有 message`, fakeJson);
} catch (e) {
  r.ok(false, `LIC-05 throw`, e.message);
}

// LIC-06: Worker admin/codes list 看到本机码
try {
  const adminRes = await fetch(`${WORKER}/admin/codes?limit=50`, {
    headers: { Authorization: `Bearer ${ADMIN}` },
  });
  const adminJson = await adminRes.json();
  r.ok(adminJson?.ok === true, `LIC-06 admin/codes 端点联通`, { count: adminJson?.count });
  const found = adminJson?.codes?.find((c) => c.code === LICENSE.code);
  r.ok(!!found, `LIC-06b admin list 找到本机码 ${LICENSE.code}`, found);
  r.ok(found?.status === 'active', `LIC-06c 本机码 status=active`, found?.status);
  r.ok(found?.bound_machine_id === LICENSE.machine_id, `LIC-06d bound_machine_id 一致`, {
    expect: LICENSE.machine_id,
    got: found?.bound_machine_id,
  });
} catch (e) {
  r.ok(false, `LIC-06 admin/codes throw`, e.message);
}

// LIC-07 (clear) skip on purpose
r.skip('LIC-07 license.clear()', '会破坏 dev 激活态, 跳过');

// LIC-08: push 通道 (license:changed) E2E
// 流程: clear → 100ms 内 DOM 出现 .activation-card → activate(LICENSE.code) → 100ms 内 .activation-card 消失 + .tabbar 出现
// 不走 Page.reload, 完全依赖主进程 push.
try {
  // 先抓取 baseline (理论上现在 main UI 已渲染)
  const baseline = await evalFn(`() => ({
    hasActivation: !!document.querySelector('.activation-card'),
    hasTabbar: !!document.querySelector('.tabbar__tab'),
  })`);
  r.ok(baseline?.hasTabbar === true && baseline?.hasActivation === false,
    `LIC-08 baseline: main UI rendered (no .activation-card, has .tabbar)`,
    baseline);

  // 注入 hook: 累计 push 事件次数
  await evalFn(`() => {
    window.__lic_pushEvents = [];
    window.__lic_unsub = window.api.license.onChanged((state) => {
      window.__lic_pushEvents.push({ status: state?.status, ts: Date.now() });
    });
    return true;
  }`);

  // Step 1: clear
  await evalFn(`async () => await window.api.license.clear()`);
  // 等 DOM 更新 (主要给 React render 一点时间)
  await new Promise((res) => setTimeout(res, 300));
  const afterClear = await evalFn(`() => ({
    hasActivation: !!document.querySelector('.activation-card'),
    hasTabbar: !!document.querySelector('.tabbar__tab'),
    pushCount: window.__lic_pushEvents?.length || 0,
    lastStatus: window.__lic_pushEvents?.slice(-1)?.[0]?.status,
  })`);
  r.ok(afterClear?.pushCount >= 1, `LIC-08b clear() 触发 push (count=${afterClear?.pushCount})`, afterClear);
  r.ok(afterClear?.lastStatus === 'unactivated', `LIC-08c push 最新 status=unactivated`, afterClear?.lastStatus);
  r.ok(afterClear?.hasActivation === true, `LIC-08d 300ms 内 DOM 出现 .activation-card`, afterClear);
  r.ok(afterClear?.hasTabbar === false, `LIC-08e 300ms 内 .tabbar 消失`, afterClear);

  // Step 2: activate
  const activateRes = await evalFn(`async () => await window.api.license.activate(${JSON.stringify(LICENSE.code)})`);
  r.ok(activateRes?.status === 'active', `LIC-08f activate(${LICENSE.code}) 返 status=active`, activateRes);
  await new Promise((res) => setTimeout(res, 300));
  const afterActivate = await evalFn(`() => ({
    hasActivation: !!document.querySelector('.activation-card'),
    hasTabbar: !!document.querySelector('.tabbar__tab'),
    pushCount: window.__lic_pushEvents?.length || 0,
    lastStatus: window.__lic_pushEvents?.slice(-1)?.[0]?.status,
  })`);
  r.ok(afterActivate?.pushCount >= 2, `LIC-08g activate() 再次触发 push (count=${afterActivate?.pushCount})`, afterActivate);
  r.ok(afterActivate?.lastStatus === 'active', `LIC-08h push 最新 status=active`, afterActivate?.lastStatus);
  r.ok(afterActivate?.hasActivation === false, `LIC-08i 300ms 内 .activation-card 消失`, afterActivate);
  r.ok(afterActivate?.hasTabbar === true, `LIC-08j 300ms 内 .tabbar 重新出现`, afterActivate);

  // Step 3: unsubscribe 应可清理
  const unsubRes = await evalFn(`() => {
    if (typeof window.__lic_unsub === 'function') {
      window.__lic_unsub();
      return 'ok';
    }
    return 'no-unsub';
  }`);
  r.ok(unsubRes === 'ok', `LIC-08k onChanged 返回 unsubscribe function`, unsubRes);
} catch (e) {
  r.ok(false, `LIC-08 push 通道测试 throw`, e.message);
}

r.summary(() => ws.close());
