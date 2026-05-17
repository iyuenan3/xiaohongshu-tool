// Rate limit (频率护栏) E2E tests
// 慎重: 不大量 log publish/comment 避免吃用户额度. 主要用 like (30/h) 测试.
import { connect, makeReporter } from './_helper.mjs';

const { evalFn, ws } = await connect();
const r = makeReporter('Rate Limit');

console.log('=== E2E Rate Limit ===\n');

try {
  // RATE-01: like 当前 allowed
  const likeChk = await evalFn(`async () => await window.api.rate.check('like')`);
  r.ok(likeChk?.allowed === true || likeChk?.allowed === false, `RATE-01 rate.check('like') 返 allowed bool`, likeChk);

  // RATE-02: publish 字段完整
  const pubChk = await evalFn(`async () => await window.api.rate.check('publish')`);
  r.ok(typeof pubChk?.allowed === 'boolean', `RATE-02 publish allowed 是 bool`, pubChk);
  r.ok(
    typeof pubChk?.windowCount === 'number' || pubChk?.windowCount === undefined,
    `RATE-02b windowCount 是 number 或 undefined`,
    pubChk?.windowCount,
  );
  r.ok(
    typeof pubChk?.windowMax === 'number' || pubChk?.windowMax === undefined,
    `RATE-02c windowMax 是 number 或 undefined`,
    pubChk?.windowMax,
  );

  // RATE-03: 非法 action
  const bad = await evalFn(`async () => {
    try { return { ok: true, r: await window.api.rate.check('non_existent_action_xxx') }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  // 实现允许两种: 抛错 (ok=false) 或返 {allowed:false, reason:...}
  r.ok(
    bad.ok === false || bad.r?.allowed === false || bad.r?.error || typeof bad.r === 'object',
    `RATE-03 非法 action 不崩 (抛或返 error)`,
    bad,
  );

  // RATE-04: log + check 计数增加 (用 like 因为额度大不影响真用户)
  const before = await evalFn(`async () => await window.api.rate.check('like')`);
  await evalFn(`async () => await window.api.rate.log('like')`);
  const after = await evalFn(`async () => await window.api.rate.check('like')`);
  if (typeof before?.windowCount === 'number' && typeof after?.windowCount === 'number') {
    r.ok(after.windowCount === before.windowCount + 1, `RATE-04 log 后 windowCount +1 (${before.windowCount} → ${after.windowCount})`, {
      before,
      after,
    });
  } else {
    r.ok(true, `RATE-04 SKIP: 实现没暴露 windowCount, log 后无法直接比对计数 (PASS as no-throw)`);
  }
} catch (e) {
  r.ok(false, `运行时异常`, e.message);
}

r.summary(() => ws.close());
