// 链路集成 E2E tests
import { connect, makeReporter, sleep, WORKER, ADMIN, LICENSE } from './_helper.mjs';

// bj license 自签证书: 放行本进程 node fetch 自签校验 (INT-03 admin fetch 用)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { evalFn, ws } = await connect({ requireMainUI: true });
const r = makeReporter('Integration');

console.log('=== E2E Integration ===\n');

const cleanupAssets = new Set();
const cleanupConvs = new Set();

async function cleanup() {
  for (const id of cleanupAssets) {
    try { await evalFn(`async () => { try { await window.api.assets.delete('${id}'); } catch(e) {} }`); } catch {}
  }
  for (const id of cleanupConvs) {
    try { await evalFn(`async () => { try { await window.api.conv.delete('${id}'); } catch(e) {} }`); } catch {}
  }
}

const IMAGE_CANDIDATES = [
  'https://www.gstatic.com/webp/gallery/1.jpg',
  'https://httpbin.org/image/jpeg',
  'https://picsum.photos/seed/int-' + Date.now() + '/300/300',
];
async function importOne() {
  for (const url of IMAGE_CANDIDATES) {
    const res = await evalFn(`async () => {
      try { return { ok: true, ...(await window.api.assets.importUrl(${JSON.stringify(url)})) }; }
      catch (e) { return { ok: false, err: String(e) }; }
    }`);
    if (res.ok) return res;
  }
  return { ok: false, err: 'all candidates failed' };
}

try {
  // INT-01: 上传图 → setTags → search → 找到 → 验证 path 一致
  console.log('  → INT-01: 上传 → setTags → search 链路');
  const imp = await importOne();
  if (!imp.ok) {
    r.ok(false, `INT-01 importUrl 失败`, imp.err);
  } else {
    cleanupAssets.add(imp.id);
    // setTags 模拟 vision 结果
    await evalFn(`async () => await window.api.assets.setTags('${imp.id}', ['特色tag-e2e-${imp.id.slice(0,4)}'], 'E2E 集成测试图片')`);
    const tagName = `特色tag-e2e-${imp.id.slice(0, 4)}`;
    const searchRes = await evalFn(`async () => await window.api.assets.search('${tagName}')`);
    const found = searchRes.find((a) => a.id === imp.id);
    r.ok(!!found, `INT-01 search 找到此图`, { tag: tagName, results: searchRes.length });
    // 验证 search 返回的 storage_path 与 getPath 一致
    const path = await evalFn(`async () => await window.api.assets.getPath('${imp.id}')`);
    r.ok(found?.storage_path === path, `INT-01b search.storage_path === getPath(id)`, { search: found?.storage_path, getPath: path });

    // 通过 xhs-asset 协议验证图能被加载 (AI 后续要拿来塞 publish_content.images)
    const loadable = await evalFn(`async () => {
      const r = await fetch('xhs-asset://${imp.id}');
      return { ok: r.ok, status: r.status };
    }`);
    r.ok(loadable.ok && loadable.status === 200, `INT-01c xhs-asset:// 协议可加载`, loadable);

    // INT-02: 上传 → list → delete → list 不含
    console.log('  → INT-02: 上传 → list → 加载 → 删除 → 不含');
    const list1 = await evalFn(`async () => (await window.api.assets.list()).find(a => a.id === '${imp.id}')`);
    r.ok(!!list1, `INT-02 list 包含此图`);
    await evalFn(`async () => await window.api.assets.delete('${imp.id}')`);
    cleanupAssets.delete(imp.id);
    const list2 = await evalFn(`async () => (await window.api.assets.list()).find(a => a.id === '${imp.id}')`);
    r.ok(!list2, `INT-02b delete 后 list 不含`);
    // 此时 xhs-asset 应该 404
    const loadAfter = await evalFn(`async () => {
      try { const r = await fetch('xhs-asset://${imp.id}'); return { ok: r.ok, status: r.status }; }
      catch (e) { return { ok: false, err: String(e) }; }
    }`);
    r.ok(loadAfter.status === 404 || loadAfter.ok === false, `INT-02c delete 后 xhs-asset 失效`, loadAfter);
  }

  // INT-03: 激活码本机绑定 → admin/codes 看到 (需 XHS_ADMIN_TOKEN env)
  if (!ADMIN) {
    r.skip('INT-03 admin/codes 一致', '需 XHS_ADMIN_TOKEN env (bj admin 鉴权)');
  } else {
    console.log('  → INT-03: admin list 与本机激活态一致');
    const status = await evalFn(`async () => await window.api.license.status()`);
    const adminRes = await fetch(`${WORKER}/admin/codes?limit=50`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    const adminJson = await adminRes.json();
    const found = adminJson?.codes?.find((c) => c.code === status?.code);
    r.ok(!!found, `INT-03 admin/codes 找到本机码 ${status?.code}`);
    r.ok(found?.status === 'active', `INT-03b 状态=active`, found?.status);
    r.ok(found?.bound_machine_id === status?.machine_id, `INT-03c bound_machine_id 一致`, {
      expect: status?.machine_id,
      got: found?.bound_machine_id,
    });
  }

  // INT-04: tab 切换 textarea 值保留
  console.log('  → INT-04: tab 切换 textarea 值保留');
  // 1) 控制台 → 在 textarea 写入文本
  await evalFn(`() => { const b = [...document.querySelectorAll('.tabbar__tab')].find(b => b.textContent.trim() === '控制台'); b && b.click(); }`);
  await sleep(150);
  const fillRes = await evalFn(`() => {
    const el = document.querySelector('.chat-panel__input textarea');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, 'INT04-e2e-保留测试-${Date.now()}');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }`);
  r.ok(fillRes, `INT-04 textarea 填值成功`);

  // 2) 切到帮助 → 切回控制台
  await evalFn(`() => { const b = [...document.querySelectorAll('.tabbar__tab')].find(b => b.textContent.trim() === '帮助'); b && b.click(); }`);
  await sleep(150);
  await evalFn(`() => { const b = [...document.querySelectorAll('.tabbar__tab')].find(b => b.textContent.trim() === '控制台'); b && b.click(); }`);
  await sleep(150);
  const v = await evalFn(`() => document.querySelector('.chat-panel__input textarea')?.value`);
  r.ok(typeof v === 'string' && v.includes('INT04-e2e-保留测试'), `INT-04b 切换 tab 后 textarea 值保留`, v);

  // 清空 textarea
  await evalFn(`() => {
    const el = document.querySelector('.chat-panel__input textarea');
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }`);
} catch (e) {
  r.ok(false, `运行时异常`, e.message);
} finally {
  await cleanup();
}

r.summary(() => ws.close());
