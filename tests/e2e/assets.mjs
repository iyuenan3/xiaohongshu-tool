// Assets 素材库 E2E tests
import { connect, makeReporter, sleep } from './_helper.mjs';

const { evalFn, ws } = await connect();
const r = makeReporter('Assets');

console.log('=== E2E Assets ===\n');

// 收集每个 case 创建的 id, 最后统一 cleanup
const cleanupIds = new Set();
function trackId(id) {
  if (id) cleanupIds.add(id);
}

async function cleanup() {
  for (const id of cleanupIds) {
    try {
      await evalFn(`async () => { try { await window.api.assets.delete('${id}'); } catch(e) {} }`);
    } catch (e) {}
  }
}

// 多个图源 fallback, 防止单个挂掉整个测试失败
const IMAGE_CANDIDATES = [
  'https://www.gstatic.com/webp/gallery/1.jpg',
  'https://httpbin.org/image/jpeg',
  'https://picsum.photos/seed/e2e-' + Date.now() + '/300/300',
];

async function importOne() {
  for (const url of IMAGE_CANDIDATES) {
    const res = await evalFn(`async () => {
      try { const r = await window.api.assets.importUrl(${JSON.stringify(url)}); return { ok: true, ...r }; }
      catch (e) { return { ok: false, err: String(e) }; }
    }`);
    if (res.ok) {
      return { ...res, sourceUrl: url };
    }
    console.log(`  · 跳过图源 ${url}: ${res.err}`);
  }
  return { ok: false, err: 'all image candidates failed' };
}

try {
  // AST-01 / AST-02: importUrl
  const imported = await importOne();
  if (!imported.ok) {
    r.ok(false, `AST-01 importUrl 全部失败 (${IMAGE_CANDIDATES.length} 候选)`, imported.err);
    r.summary(() => ws.close());
  }
  console.log(`  · 使用图源 ${imported.sourceUrl}`);
  trackId(imported.id);
  r.ok(/^picture-\d{8}-\d{6}-\d+\.jpg$/.test(imported.filename), `AST-01 filename 格式 picture-YYYYMMDD-HHmmss-N.jpg`, imported.filename);
  r.ok(imported.mime_type === 'image/jpeg', `AST-02 mime=image/jpeg`, imported.mime_type);
  r.ok(imported.size > 1024, `AST-02b size>1KB`, imported.size);

  // AST-03: list contains it
  const list1 = await evalFn(`async () => await window.api.assets.list()`);
  const found = list1.find((a) => a.id === imported.id);
  r.ok(!!found, `AST-03 list 包含新导入`, { len: list1.length, found: !!found });

  // AST-04: 默认字段
  r.ok(found?.tags === '[]', `AST-04 默认 tags='[]'`, found?.tags);
  r.ok(found?.description === null, `AST-04b description=null`, found?.description);
  r.ok(found?.analyzed === 0, `AST-04c analyzed=0`, found?.analyzed);

  // AST-05: setTags
  const setRes = await evalFn(`async () => {
    try { await window.api.assets.setTags('${imported.id}', ['猫','户外','夜景'], '一只在草地上的小猫'); return { ok: true }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(setRes.ok, `AST-05 setTags 成功`, setRes);

  const tagged = await evalFn(`async () => (await window.api.assets.list()).find(a => a.id === '${imported.id}')`);
  const parsedTags = tagged?.tags ? JSON.parse(tagged.tags) : null;
  r.ok(JSON.stringify(parsedTags) === JSON.stringify(['猫', '户外', '夜景']), `AST-05b tags 入库`, tagged?.tags);
  r.ok(tagged?.description === '一只在草地上的小猫', `AST-05c description 入库`, tagged?.description);
  r.ok(tagged?.analyzed === 1, `AST-05d analyzed=1`, tagged?.analyzed);

  // AST-06 ~ AST-08: search
  const byTag = await evalFn(`async () => await window.api.assets.search('猫')`);
  r.ok(byTag.some((a) => a.id === imported.id), `AST-06 search '猫' 命中 (${byTag.length} 条)`);
  const byDesc = await evalFn(`async () => await window.api.assets.search('草地')`);
  r.ok(byDesc.some((a) => a.id === imported.id), `AST-07 search '草地' 命中 description`);
  const byName = await evalFn(`async () => await window.api.assets.search('picture')`);
  r.ok(byName.some((a) => a.id === imported.id), `AST-08 search 'picture' 命中 filename`);

  // AST-09: 不存在的关键词
  const miss = await evalFn(`async () => await window.api.assets.search('xyz123zzz不存在的关键词abc')`);
  r.ok(!miss.some((a) => a.id === imported.id), `AST-09 search 不存在的关键词 不返回此 id (${miss.length} 条)`);

  // AST-10: 空 query
  const empty = await evalFn(`async () => {
    try { return { ok: true, res: await window.api.assets.search('') }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(empty.ok && Array.isArray(empty.res), `AST-10 空 query 不崩 + 返回数组 (${empty.res?.length})`, empty.err);

  // AST-11: limit=2 边界
  const lim2 = await evalFn(`async () => await window.api.assets.search('picture', 2)`);
  r.ok(Array.isArray(lim2) && lim2.length <= 2, `AST-11 limit=2 返回 ≤2 (${lim2?.length})`);

  // AST-12: getPath
  const path = await evalFn(`async () => await window.api.assets.getPath('${imported.id}')`);
  r.ok(typeof path === 'string' && path.length > 0, `AST-12 getPath 非空`, path);

  // AST-13: xhs-asset:// 协议
  const xhsLoad = await evalFn(`async () => {
    try {
      const r = await fetch('xhs-asset://${imported.id}');
      const buf = await r.arrayBuffer();
      return { ok: r.ok, status: r.status, type: r.headers.get('content-type'), len: buf.byteLength };
    } catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(xhsLoad.ok && xhsLoad.status === 200, `AST-13 xhs-asset:// 200`, xhsLoad);
  r.ok(xhsLoad.type?.startsWith('image/'), `AST-13b content-type image/*`, xhsLoad.type);
  r.ok(xhsLoad.len > 1000, `AST-13c 内容 >1KB`, xhsLoad.len);

  // AST-14: xhs-asset:// 不存在的 id
  const xhsMiss = await evalFn(`async () => {
    try {
      const r = await fetch('xhs-asset://not-exist-id-xxx');
      return { ok: r.ok, status: r.status };
    } catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(xhsMiss.status === 404 || xhsMiss.ok === false, `AST-14 xhs-asset:// 不存在 id 返 404 或错误`, xhsMiss);

  // AST-15: touchUsed 更新 last_used_at
  const before = await evalFn(`async () => (await window.api.assets.list()).find(a => a.id === '${imported.id}').last_used_at`);
  await sleep(1100); // 等 1 秒+让 ts 不同
  await evalFn(`async () => await window.api.assets.touchUsed(['${imported.id}'])`);
  const after = await evalFn(`async () => (await window.api.assets.list()).find(a => a.id === '${imported.id}').last_used_at`);
  r.ok(after > before, `AST-15 touchUsed 更新 last_used_at (${before} → ${after})`);

  // AST-17: delete 不存在的 id (idempotent)
  const delMiss = await evalFn(`async () => {
    try { await window.api.assets.delete('non-existent-id-xxx'); return { ok: true }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(delMiss.ok, `AST-17 delete 不存在 id idempotent (不抛)`, delMiss.err);

  // AST-18: importUrl 非法 URL
  const badUrl = await evalFn(`async () => {
    try { const r = await window.api.assets.importUrl('not-a-url'); return { ok: true, r }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(badUrl.ok === false || badUrl.r === null, `AST-18 importUrl 非法 URL 抛错/null`, badUrl);

  // AST-16: delete 后 list 不包含
  await evalFn(`async () => await window.api.assets.delete('${imported.id}')`);
  cleanupIds.delete(imported.id);
  const list2 = await evalFn(`async () => await window.api.assets.list()`);
  r.ok(!list2.some((a) => a.id === imported.id), `AST-16 delete 后 list 不含`, { remaining: list2.length });
} catch (e) {
  r.ok(false, `运行时异常`, e.message);
} finally {
  await cleanup();
}

r.summary(() => ws.close());
