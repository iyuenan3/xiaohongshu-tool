// Chat / Conversation CRUD E2E tests
import { connect, makeReporter, sleep } from './_helper.mjs';

const { evalFn, ws } = await connect();
const r = makeReporter('Chat/Conv');

console.log('=== E2E Chat / Conversation ===\n');

const cleanupIds = new Set();
async function cleanup() {
  for (const id of cleanupIds) {
    try {
      await evalFn(`async () => { try { await window.api.conv.delete('${id}'); } catch(e) {} }`);
    } catch (e) {}
  }
}

try {
  // CONV-01: list
  const list0 = await evalFn(`async () => await window.api.conv.list()`);
  r.ok(Array.isArray(list0), `CONV-01 conv.list 返回数组 (${list0?.length})`);

  // CONV-02: create
  const newId = await evalFn(`async () => await window.api.conv.create()`);
  r.ok(typeof newId === 'string' && newId.length > 0, `CONV-02 conv.create 返回 id`, newId);
  cleanupIds.add(newId);

  // CONV-03: 新建后 list 包含
  const list1 = await evalFn(`async () => await window.api.conv.list()`);
  r.ok(list1.some((c) => c.id === newId), `CONV-03 新建后 list 包含 (${list1.length})`);

  // CONV-04: get 返 meta + messages=[]
  const got1 = await evalFn(`async () => await window.api.conv.get('${newId}')`);
  r.ok(got1?.meta?.id === newId, `CONV-04 get(id) 返 meta.id 一致`, got1?.meta);
  r.ok(Array.isArray(got1?.messages) && got1.messages.length === 0, `CONV-04b 新建 messages=[]`, got1?.messages);

  // CONV-05: setTitle
  const setT = await evalFn(`async () => await window.api.conv.setTitle('${newId}', 'E2E 测试会话')`);
  r.ok(setT?.ok === true, `CONV-05 setTitle ok=true`, setT);
  const got2 = await evalFn(`async () => await window.api.conv.get('${newId}')`);
  r.ok(got2?.meta?.title === 'E2E 测试会话', `CONV-05b title 已更新`, got2?.meta?.title);

  // CONV-06: saveMessages
  const msgs = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好！有什么可以帮你？' },
  ];
  const saveRes = await evalFn(`async () => await window.api.conv.saveMessages('${newId}', ${JSON.stringify(msgs)})`);
  r.ok(saveRes?.ok === true, `CONV-06 saveMessages ok=true`, saveRes);
  const got3 = await evalFn(`async () => await window.api.conv.get('${newId}')`);
  r.ok(got3?.messages?.length === 2, `CONV-06b get 返回 2 条消息 (${got3?.messages?.length})`);
  r.ok(got3?.messages?.[0]?.role === 'user' && got3?.messages?.[0]?.content === '你好', `CONV-06c user 消息一致`);
  r.ok(got3?.messages?.[1]?.role === 'assistant', `CONV-06d assistant 消息存在`);

  // CONV-07: clearMessages
  const cleared = await evalFn(`async () => await window.api.conv.clearMessages('${newId}')`);
  r.ok(cleared?.ok === true, `CONV-07 clearMessages ok=true`);
  const got4 = await evalFn(`async () => await window.api.conv.get('${newId}')`);
  r.ok(got4?.messages?.length === 0, `CONV-07b 清空后 messages=[] (${got4?.messages?.length})`);

  // CONV-09: get 不存在的 id
  const notExist = await evalFn(`async () => {
    try { return { ok: true, r: await window.api.conv.get('non-exist-id-xxx-yyy') }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(notExist.ok && (notExist.r?.meta === null || notExist.r?.meta === undefined), `CONV-09 不存在 id meta=null`, notExist);

  // CONV-10: setTitle 超长 (1000 字符)
  const long = 'A'.repeat(1000);
  const setLong = await evalFn(`async () => {
    try { const r = await window.api.conv.setTitle('${newId}', '${long}'); return { ok: true, r }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(setLong.ok && setLong.r?.ok === true, `CONV-10 setTitle 超长 不崩`, setLong.err);

  // CONV-11: saveMessages 大量 (50 条)
  const big = [];
  for (let i = 0; i < 50; i++) {
    big.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` });
  }
  const saveBig = await evalFn(`async () => {
    try { const r = await window.api.conv.saveMessages('${newId}', ${JSON.stringify(big)}); return { ok: true, r }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(saveBig.ok && saveBig.r?.ok === true, `CONV-11 saveMessages 50 条 不崩`, saveBig.err);
  const got5 = await evalFn(`async () => (await window.api.conv.get('${newId}')).messages.length`);
  r.ok(got5 === 50, `CONV-11b get 50 条 (${got5})`);

  // CONV-12: delete 不存在的 id
  const delMiss = await evalFn(`async () => {
    try { const r = await window.api.conv.delete('non-exist-id-zzz'); return { ok: true, r }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(delMiss.ok, `CONV-12 delete 不存在 id idempotent`, delMiss.err);

  // CONV-13: list 顺序 by updated_at desc
  // 新建另一个, 看是否在第一位
  const id2 = await evalFn(`async () => await window.api.conv.create()`);
  cleanupIds.add(id2);
  await sleep(50);
  const listOrder = await evalFn(`async () => await window.api.conv.list()`);
  // 找到 id2 和 newId 的位置
  const idx2 = listOrder.findIndex((c) => c.id === id2);
  const idx1 = listOrder.findIndex((c) => c.id === newId);
  r.ok(idx2 !== -1 && idx1 !== -1, `CONV-13 两个 id 都在 list 中`, { idx1, idx2 });
  // id2 更新, newId 较老 (saveMessages 后), 但 id2 是 create 后立刻列, 应该 idx2 < idx1
  r.ok(idx2 < idx1 || idx2 === idx1, `CONV-13b 新建的 id2 在 newId 之前 (idx2=${idx2}, idx1=${idx1})`);

  // CONV-08: delete
  await evalFn(`async () => await window.api.conv.delete('${newId}')`);
  cleanupIds.delete(newId);
  const list3 = await evalFn(`async () => await window.api.conv.list()`);
  r.ok(!list3.some((c) => c.id === newId), `CONV-08 delete 后 list 不含 newId`);
} catch (e) {
  r.ok(false, `运行时异常`, e.message);
} finally {
  await cleanup();
}

r.summary(() => ws.close());
