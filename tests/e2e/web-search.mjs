// Web search E2E tests
import { connect, makeReporter } from './_helper.mjs';

const { evalFn, ws } = await connect();
const r = makeReporter('Web Search');

console.log('=== E2E Web Search (sogou) ===\n');

try {
  // WEB-01: API 暴露
  const hasApi = await evalFn(`() => typeof window.api?.web?.search === 'function'`);
  r.ok(hasApi === true, `WEB-01 window.api.web.search 暴露`);

  // WEB-02 / WEB-03: 真实搜索
  console.log('  → search "露营帐篷推荐 2026" ...');
  const t0 = Date.now();
  const res = await evalFn(`async () => {
    try { return { ok: true, list: await window.api.web.search('露营帐篷推荐 2026', 5) }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  const elapsed = Date.now() - t0;
  if (!res.ok) {
    r.ok(false, `WEB-02 搜索失败`, res.err);
  } else {
    console.log(`    耗时: ${elapsed}ms, ${res.list.length} 条`);
    r.ok(Array.isArray(res.list), `WEB-02 返回数组`);
    r.ok(res.list.length >= 3, `WEB-02b 返回 ≥3 条 (${res.list.length})`);
    const allValid = res.list.every(
      (x) => typeof x.title === 'string' && typeof x.url === 'string' && typeof x.snippet === 'string',
    );
    r.ok(allValid, `WEB-03 每条结构 {title,url,snippet} 类型对`);
    const valid = res.list.filter((x) => x.title && x.title !== '搜索失败' && x.title !== '无结果');
    r.ok(valid.length > 0, `WEB-03b 有效结果数 ${valid.length}`);
  }

  // WEB-04: 连续 2 次 (mutex + 销毁)
  console.log('  → 连续第二次搜索 ...');
  const res2 = await evalFn(`async () => {
    try { return { ok: true, list: await window.api.web.search('iPhone 17', 3) }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  if (!res2.ok) {
    r.ok(false, `WEB-04 第二次搜索 throw`, res2.err);
  } else {
    r.ok(Array.isArray(res2.list) && res2.list.length > 0, `WEB-04 第二次返回 ≥1 (${res2.list.length})`);
  }

  // WEB-05: n=1 边界
  const res3 = await evalFn(`async () => {
    try { return { ok: true, list: await window.api.web.search('猫', 1) }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  if (res3.ok) {
    r.ok(Array.isArray(res3.list), `WEB-05 n=1 返回数组 (${res3.list.length} 条)`);
  } else {
    r.ok(false, `WEB-05 n=1 throw`, res3.err);
  }

  // WEB-06: 空 query
  const res4 = await evalFn(`async () => {
    try { return { ok: true, list: await window.api.web.search('', 3) }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(res4.ok && Array.isArray(res4.list), `WEB-06 空 query 不崩 + 返回数组 (${res4.list?.length})`, res4.err);

  // WEB-07: 超长 query (500 字)
  const longQuery = '我想要找'.repeat(125); // 500 chars
  const res5 = await evalFn(`async () => {
    try { return { ok: true, list: await window.api.web.search(${JSON.stringify(longQuery)}, 3) }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(res5.ok && Array.isArray(res5.list), `WEB-07 超长 query 不崩 (${res5.list?.length} 条)`, res5.err);
} catch (e) {
  r.ok(false, `运行时异常`, e.message);
}

r.summary(() => ws.close());
