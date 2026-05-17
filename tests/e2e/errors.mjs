// Errors / 异常输入 E2E tests
import { connect, makeReporter } from './_helper.mjs';

const { evalFn, ws } = await connect();
const r = makeReporter('Errors');

console.log('=== E2E Errors ===\n');

try {
  // ERR-01: goApi 不存在的 path
  const goMiss = await evalFn(`async () => {
    try { return { ok: true, r: await window.api.goApi('GET', '/api/v1/non-existent-path-zzz', {}) }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(goMiss.ok === true || (goMiss.ok === false && typeof goMiss.err === 'string'), `ERR-01 goApi 不存在 path 不崩 (返/抛)`, goMiss);

  // ERR-02: goApi POST 但 body=null
  const goNullBody = await evalFn(`async () => {
    try { return { ok: true, r: await window.api.goApi('POST', '/api/v1/check_login_status', null) }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(goNullBody.ok === true || goNullBody.ok === false, `ERR-02 goApi body=null 不崩`, goNullBody);

  // ERR-03: GET 端点带空 body (踩坑已修, 不该报 GET-with-body)
  const goGetWithEmptyBody = await evalFn(`async () => {
    try { return { ok: true, r: await window.api.goApi('GET', '/health', {}) }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(goGetWithEmptyBody.ok === true, `ERR-03 goApi GET 带 {} body 不报错 (踩坑已修)`, goGetWithEmptyBody);

  // ERR-04: license.activate 非法 code
  const actInvalid = await evalFn(`async () => {
    try { return { ok: true, r: await window.api.license.activate('abc') }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(actInvalid.ok && actInvalid.r?.status !== 'active', `ERR-04 activate 'abc' 不变 active`, actInvalid);
  r.ok(typeof actInvalid.r?.message === 'string' || actInvalid.r?.status, `ERR-04b 返 message 或 status`, actInvalid.r);

  // ERR-05: license.activate 空字符串
  const actEmpty = await evalFn(`async () => {
    try { return { ok: true, r: await window.api.license.activate('') }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(actEmpty.ok && actEmpty.r?.status !== 'active', `ERR-05 activate '' 不变 active`, actEmpty);

  // ERR-06: assets.delete 不存在 id
  const delMiss = await evalFn(`async () => {
    try { await window.api.assets.delete('non-exist-id-zzz'); return { ok: true }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(delMiss.ok, `ERR-06 delete 不存在 id idempotent`, delMiss.err);

  // ERR-07: assets.getPath 不存在 id
  const pathMiss = await evalFn(`async () => {
    try { return { ok: true, r: await window.api.assets.getPath('non-exist-id-zzz') }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(pathMiss.ok && (pathMiss.r === null || pathMiss.r === undefined), `ERR-07 getPath 不存在返 null`, pathMiss);

  // ERR-08: xhs-asset:// 非法 id
  const xhsBad = await evalFn(`async () => {
    try {
      const r = await fetch('xhs-asset://not-existing-asset-xxx');
      return { ok: true, status: r.status, type: r.headers.get('content-type') };
    } catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(xhsBad.status === 404 || xhsBad.ok === false, `ERR-08 xhs-asset 非法 id 404 或错误`, xhsBad);

  // ERR-Extra: conv.get 不存在 id
  const cvMiss = await evalFn(`async () => {
    try { return { ok: true, r: await window.api.conv.get('non-exist-id-zzz') }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(cvMiss.ok && (cvMiss.r?.meta === null || cvMiss.r?.meta === undefined), `ERR-Extra conv.get 不存在 id meta=null`, cvMiss);
} catch (e) {
  r.ok(false, `运行时异常`, e.message);
}

r.summary(() => ws.close());
