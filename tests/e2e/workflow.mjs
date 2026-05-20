// M7 工作流模块 E2E tests
// 覆盖: IPC 表面 / templates / CRUD / schedule type / config / push listener / error path
//
// ⚠️  本套件绝不调 workflow.runNow / workflow.devFireSoon (会真实跑小红书)
// ⚠️  也不依赖 license active + go ready, 但 connect 后会 detect 这俩 OK
import { connect, makeReporter, sleep } from './_helper.mjs';

const { evalFn, ws } = await connect({ requireMainUI: true });
const r = makeReporter('Workflow');

console.log('=== E2E Workflow (M7) ===\n');

// 收集 create 出来的 id, 最后统一 cleanup
const cleanupIds = new Set();
function trackId(id) {
  if (typeof id === 'number' && id > 0) cleanupIds.add(id);
}
async function cleanup() {
  for (const id of cleanupIds) {
    try {
      await evalFn(`async () => { try { await window.api.workflow.delete(${id}); } catch(e) {} }`);
    } catch (e) {}
  }
}

// helper: 在 renderer 内调一个 workflow API 并返回 {ok, r, err}
async function callApi(expr) {
  return evalFn(`async () => {
    try { const r = await (${expr}); return { ok: true, r }; }
    catch (e) { return { ok: false, err: String(e?.message || e) }; }
  }`);
}

try {
  // ============ 1. IPC 表面存活 ============
  const apiShape = await evalFn(`() => {
    const w = window.api?.workflow;
    if (!w) return null;
    const out = {};
    for (const k of ['list','get','create','update','enable','delete','runNow','runs','getTemplates','devFireSoon','getConfig','setConfig','onRunStarted','onRunStepUpdate','onRunFinished','onAutoDisabled']) {
      out[k] = typeof w[k];
    }
    return out;
  }`);
  r.ok(apiShape !== null, 'WF-01a window.api.workflow 暴露', apiShape);
  if (apiShape) {
    const allFn = Object.entries(apiShape).every(([_, t]) => t === 'function');
    r.ok(allFn, 'WF-01b 所有 15 个方法都是 function', apiShape);
  }

  const listSurface = await callApi(`window.api.workflow.list()`);
  r.ok(listSurface.ok && Array.isArray(listSurface.r), 'WF-01c list() 不 throw + 返数组', listSurface);

  const tmplSurface = await callApi(`window.api.workflow.getTemplates()`);
  r.ok(tmplSurface.ok && Array.isArray(tmplSurface.r), 'WF-01d getTemplates() 不 throw + 返数组', tmplSurface);

  const cfgSurface = await callApi(`window.api.workflow.getConfig('any_arbitrary_key')`);
  r.ok(cfgSurface.ok, 'WF-01e getConfig(任意 key) 不 throw', cfgSurface);

  // ============ 2. getTemplates 内容校验 ============
  const templates = tmplSurface.r || [];
  r.ok(templates.length >= 1, `WF-02a getTemplates 返 >=1 (${templates.length})`);
  const daily = templates.find((t) => t.id === 'daily_like_comment');
  r.ok(!!daily, 'WF-02b 含 daily_like_comment 模板', { ids: templates.map((t) => t.id) });
  if (daily) {
    r.ok(typeof daily.name === 'string' && daily.name.length > 0, 'WF-02c daily.name 是非空 string', daily.name);
    r.ok(typeof daily.paramsSchema === 'object' && daily.paramsSchema, 'WF-02d daily.paramsSchema 是 object');
    r.ok(daily.paramsSchema?.top_n !== undefined, 'WF-02e paramsSchema.top_n 存在', daily.paramsSchema?.top_n);
    r.ok(daily.paramsSchema?.comment_style !== undefined, 'WF-02f paramsSchema.comment_style 存在', daily.paramsSchema?.comment_style);
    r.ok(daily.paramsSchema?.top_n?.type === 'int', 'WF-02g top_n.type=int', daily.paramsSchema?.top_n?.type);
    r.ok(daily.paramsSchema?.comment_style?.type === 'enum', 'WF-02h comment_style.type=enum', daily.paramsSchema?.comment_style?.type);
  }

  // ============ 3. 空状态 (尽量) ============
  // 不保证 SQLite 已清, 仅记录初始 list 长度, 用于后续验证 delta
  const initialList = listSurface.r || [];
  const initialLen = initialList.length;
  console.log(`  · 初始 workflow 数: ${initialLen} (非干净环境, 仅记录基线)`);

  // ============ 4. CRUD 闭环 (daily_like_comment) ============
  const createInput = {
    template_id: 'daily_like_comment',
    name: 'E2E-CRUD-TEST',
    params: { top_n: 2, comment_style: 'praise' },
    schedule: { type: 'daily', hour: 9, minute: 0, jitter_min: 10, tz: 'Asia/Shanghai' },
    enabled: false,
  };
  const created = await callApi(`window.api.workflow.create(${JSON.stringify(createInput)})`);
  r.ok(created.ok && created.r && typeof created.r.id === 'number', 'WF-04a create 返 Workflow 含 number id', created);
  const wfId = created.r?.id;
  trackId(wfId);
  if (wfId) {
    r.ok(created.r.template_id === 'daily_like_comment', 'WF-04b template_id 入库', created.r.template_id);
    r.ok(created.r.name === 'E2E-CRUD-TEST', 'WF-04c name 入库', created.r.name);
    // params 入库是 JSON string
    r.ok(typeof created.r.params === 'string', 'WF-04d params 入库 是 string', typeof created.r.params);
    const parsedParams = (() => { try { return JSON.parse(created.r.params); } catch { return null; } })();
    r.ok(parsedParams?.top_n === 2 && parsedParams?.comment_style === 'praise', 'WF-04e params JSON 内容一致', parsedParams);
    r.ok(typeof created.r.schedule === 'string', 'WF-04f schedule 是 string', typeof created.r.schedule);
    r.ok(created.r.enabled === 0, 'WF-04g enabled=false → 0', created.r.enabled);
    r.ok(created.r.deleted_at === null, 'WF-04h deleted_at=null', created.r.deleted_at);
    r.ok(typeof created.r.created_at === 'number' && created.r.created_at > 0, 'WF-04i created_at 是 ts', created.r.created_at);

    // 4.x list 含此 workflow
    const listAfterCreate = await callApi(`window.api.workflow.list()`);
    const foundInList = (listAfterCreate.r || []).find((w) => w.id === wfId);
    r.ok(!!foundInList, 'WF-04j list 含新建 workflow', { id: wfId, listLen: listAfterCreate.r?.length });
    r.ok(foundInList?.name === 'E2E-CRUD-TEST', 'WF-04k list 内 name 一致', foundInList?.name);

    // 4.x get(id) 返同样数据
    const got = await callApi(`window.api.workflow.get(${wfId})`);
    r.ok(got.ok && got.r?.id === wfId, 'WF-04l get(id) 返同 id', got);
    r.ok(got.r?.name === 'E2E-CRUD-TEST', 'WF-04m get.name 一致', got.r?.name);
    r.ok(got.r?.template_id === 'daily_like_comment', 'WF-04n get.template_id 一致', got.r?.template_id);

    // 4.x update name
    const updRes = await callApi(`window.api.workflow.update(${wfId}, { name: 'NEW NAME' })`);
    r.ok(updRes.ok && updRes.r?.ok === true, 'WF-04o update(name) ok=true', updRes);
    const listAfterUpd = await callApi(`window.api.workflow.list()`);
    const foundUpd = (listAfterUpd.r || []).find((w) => w.id === wfId);
    r.ok(foundUpd?.name === 'NEW NAME', 'WF-04p update 后 list.name=NEW NAME', foundUpd?.name);

    // 4.x enable(id, true)
    const en1 = await callApi(`window.api.workflow.enable(${wfId}, true)`);
    r.ok(en1.ok && en1.r?.ok === true, 'WF-04q enable(true) ok=true', en1);
    const listEn = await callApi(`window.api.workflow.list()`);
    const fEn = (listEn.r || []).find((w) => w.id === wfId);
    r.ok(fEn?.enabled === 1, 'WF-04r enabled=1', fEn?.enabled);

    // 4.x enable(id, false)
    const en0 = await callApi(`window.api.workflow.enable(${wfId}, false)`);
    r.ok(en0.ok && en0.r?.ok === true, 'WF-04s enable(false) ok=true', en0);
    const listDis = await callApi(`window.api.workflow.list()`);
    const fDis = (listDis.r || []).find((w) => w.id === wfId);
    r.ok(fDis?.enabled === 0, 'WF-04t enabled=0', fDis?.enabled);

    // 4.x runs(id) 没真跑过 应返 []
    const runs1 = await callApi(`window.api.workflow.runs(${wfId})`);
    r.ok(runs1.ok && Array.isArray(runs1.r), 'WF-04u runs(id) 返数组', runs1);
    r.ok(Array.isArray(runs1.r) && runs1.r.length === 0, `WF-04v runs(id) 无真跑 应=[] (${runs1.r?.length})`, runs1.r);

    // 4.x delete (soft)
    const delRes = await callApi(`window.api.workflow.delete(${wfId})`);
    r.ok(delRes.ok && delRes.r?.ok === true, 'WF-04w delete ok=true', delRes);
    cleanupIds.delete(wfId);
    const listAfterDel = await callApi(`window.api.workflow.list()`);
    const stillThere = (listAfterDel.r || []).find((w) => w.id === wfId);
    r.ok(!stillThere, 'WF-04x delete 后 list 不再含 (soft delete 默认隐藏)', { listLen: listAfterDel.r?.length });

    // 4.y delete 已删 id 幂等
    const delAgain = await callApi(`window.api.workflow.delete(${wfId})`);
    r.ok(delAgain.ok, 'WF-04y delete 已删 id idempotent (不 throw)', delAgain);
  } else {
    r.ok(false, 'WF-04 create 失败, 跳过后续 CRUD', created);
  }

  // ============ 5. Schedule type 全覆盖 ============
  const scheduleVariants = [
    { type: 'daily', hour: 8, minute: 30, jitter_min: 10, tz: 'Asia/Shanghai' },
    { type: 'weekly', weekday: 3, hour: 10, minute: 0, jitter_min: 10, tz: 'Asia/Shanghai' },
    { type: 'interval', interval_hours: 6, jitter_min: 5, tz: 'Asia/Shanghai' },
    { type: 'manual', tz: 'Asia/Shanghai' },
  ];
  const variantIds = [];
  for (const sched of scheduleVariants) {
    const input = {
      template_id: 'daily_like_comment',
      name: `E2E-SCHED-${sched.type}`,
      params: { top_n: 2, comment_style: 'short' },
      schedule: sched,
      enabled: false,
    };
    const c = await callApi(`window.api.workflow.create(${JSON.stringify(input)})`);
    r.ok(c.ok && typeof c.r?.id === 'number', `WF-05 create schedule.type=${sched.type} 不 throw`, c);
    if (c.r?.id) {
      variantIds.push(c.r.id);
      trackId(c.r.id);
      // 验证 schedule JSON 入库
      const parsedSched = (() => { try { return JSON.parse(c.r.schedule); } catch { return null; } })();
      r.ok(parsedSched?.type === sched.type, `WF-05 schedule.type=${sched.type} JSON 入库`, parsedSched);
    }
  }
  // list 都看得到
  const listAllSched = await callApi(`window.api.workflow.list()`);
  for (const id of variantIds) {
    const f = (listAllSched.r || []).find((w) => w.id === id);
    r.ok(!!f, `WF-05 list 含 schedule variant id=${id}`);
  }
  // 测完 delete 掉
  for (const id of variantIds) {
    const d = await callApi(`window.api.workflow.delete(${id})`);
    r.ok(d.ok && d.r?.ok === true, `WF-05 delete schedule variant id=${id}`);
    cleanupIds.delete(id);
  }

  // ============ 6. 风险确认 config state ============
  const KEY = 'workflow_risk_accepted';
  // 先保存原值, 测完恢复
  const orig = await callApi(`window.api.workflow.getConfig('${KEY}')`);
  console.log(`  · ${KEY} 原值: ${JSON.stringify(orig.r)}`);

  // 6.a getConfig 未存在的 key 返 null
  const unknownKey = await callApi(`window.api.workflow.getConfig('definitely_not_a_real_key_xxx_e2e_${Date.now()}')`);
  r.ok(unknownKey.ok && unknownKey.r === null, 'WF-06a getConfig(不存在 key) 返 null', unknownKey);

  // 6.b setConfig('1')
  const set1 = await callApi(`window.api.workflow.setConfig('${KEY}', '1')`);
  r.ok(set1.ok && set1.r?.ok === true, 'WF-06b setConfig(KEY, "1") ok=true', set1);
  const get1 = await callApi(`window.api.workflow.getConfig('${KEY}')`);
  r.ok(get1.ok && get1.r === '1', 'WF-06c getConfig 返 "1"', get1);

  // 6.c 重复 setConfig 幂等
  const set1Again = await callApi(`window.api.workflow.setConfig('${KEY}', '1')`);
  r.ok(set1Again.ok && set1Again.r?.ok === true, 'WF-06d 重复 setConfig 幂等不 throw', set1Again);
  const get1Again = await callApi(`window.api.workflow.getConfig('${KEY}')`);
  r.ok(get1Again.ok && get1Again.r === '1', 'WF-06e 重复 set 后 getConfig 还是 "1"', get1Again);

  // 不刻意恢复原值 (任务说明: 留 '1' 也行)

  // ============ 7. push event listener 注册 / 注销 ============
  // 在 renderer 把 4 个 onXxx 注册一下, 拿到 unregister fn (typeof === 'function'), 调一下不 throw
  const listenerCheck = await evalFn(`() => {
    try {
      const w = window.api.workflow;
      const noop = () => {};
      const u1 = w.onRunStarted(noop);
      const u2 = w.onRunStepUpdate(noop);
      const u3 = w.onRunFinished(noop);
      const u4 = w.onAutoDisabled(noop);
      const types = { u1: typeof u1, u2: typeof u2, u3: typeof u3, u4: typeof u4 };
      // 调用 unregister
      let threw = false;
      try { u1(); u2(); u3(); u4(); } catch (e) { threw = String(e); }
      return { ok: true, types, threw };
    } catch (e) {
      return { ok: false, err: String(e?.message || e) };
    }
  }`);
  r.ok(listenerCheck.ok, 'WF-07a 4 个 listener 注册不 throw', listenerCheck);
  if (listenerCheck.ok) {
    const t = listenerCheck.types;
    r.ok(
      t.u1 === 'function' && t.u2 === 'function' && t.u3 === 'function' && t.u4 === 'function',
      'WF-07b 4 个 listener 返 unregister fn',
      t,
    );
    r.ok(listenerCheck.threw === false, 'WF-07c unregister 调用不 throw', listenerCheck.threw);
  }

  // ============ 8. 错误 path ============
  // 8.a get(99999) → null
  const missingGet = await callApi(`window.api.workflow.get(99999)`);
  r.ok(missingGet.ok, 'WF-08a get(99999) 不 throw', missingGet);
  r.ok(missingGet.r === null, 'WF-08b get(不存在 id) 返 null', missingGet.r);

  // 8.b create 缺 template_id (传 undefined)
  // 注意: workflow:create 入参 input 包含 template_id, name, params, schedule. 缺一会怎样
  // 由于 better-sqlite3 INSERT 会因 NOT NULL constraint 抛错 → ipc.invoke reject → 测试视为 throw
  const createMissingTplId = await callApi(`window.api.workflow.create({
    name: 'E2E-MISSING-TPL',
    params: { top_n: 1 },
    schedule: { type: 'manual', tz: 'Asia/Shanghai' },
    enabled: false,
  })`);
  // 行为: throw 或 ok:false 都接受 (但不能 silently 成功创建无效 workflow)
  if (createMissingTplId.ok && createMissingTplId.r?.id) {
    // 居然成功了 → bug, 但要 cleanup
    trackId(createMissingTplId.r.id);
    r.ok(false, 'WF-08c create 缺 template_id 应失败但居然成功', createMissingTplId.r);
  } else {
    r.ok(true, 'WF-08c create 缺 template_id 失败 (throw or ok:false)', { ok: createMissingTplId.ok, err: createMissingTplId.err });
  }

  // 8.c delete 已删 id (新建一个删了再删一遍)
  const tmpInput = {
    template_id: 'daily_like_comment',
    name: 'E2E-TMP-DEL',
    params: { top_n: 1, comment_style: 'praise' },
    schedule: { type: 'manual', tz: 'Asia/Shanghai' },
    enabled: false,
  };
  const tmpCreated = await callApi(`window.api.workflow.create(${JSON.stringify(tmpInput)})`);
  if (tmpCreated.ok && tmpCreated.r?.id) {
    const tmpId = tmpCreated.r.id;
    trackId(tmpId);
    const del1 = await callApi(`window.api.workflow.delete(${tmpId})`);
    r.ok(del1.ok && del1.r?.ok === true, 'WF-08d delete 已存在 id ok=true');
    cleanupIds.delete(tmpId);
    const del2 = await callApi(`window.api.workflow.delete(${tmpId})`);
    r.ok(del2.ok && del2.r?.ok === true, 'WF-08e delete 已删 id 幂等 ok=true', del2);
  } else {
    r.ok(false, 'WF-08d-prep 临时创建失败, 跳过 delete 幂等测试', tmpCreated);
  }

  // ============ 9. 不存在的模板 id ============
  // 用 nonexistent_xxx 作 template_id. 行为: 因为 INSERT 只看 string 不验证 templateId 合法性,
  // 故应该 create 成功 (但 enabled=false 不会触发 scheduler.rescheduleOne → 不 crash). 删了即可
  const badTplInput = {
    template_id: 'nonexistent_xxx_e2e_should_not_exist',
    name: 'E2E-BAD-TPL',
    params: { top_n: 1 },
    schedule: { type: 'manual', tz: 'Asia/Shanghai' },
    enabled: false,
  };
  const badTpl = await callApi(`window.api.workflow.create(${JSON.stringify(badTplInput)})`);
  // 主流程不 crash 即可 — create 成功 / throw 均接受
  if (badTpl.ok && badTpl.r?.id) {
    trackId(badTpl.r.id);
    r.ok(true, 'WF-09 create 不存在 template_id 成功 (enabled:false 不进 scheduler)', { id: badTpl.r.id });
    // 清理
    await callApi(`window.api.workflow.delete(${badTpl.r.id})`);
    cleanupIds.delete(badTpl.r.id);
  } else {
    r.ok(true, 'WF-09 create 不存在 template_id 失败 (拒绝亦可)', { err: badTpl.err });
  }

  // 验证进程仍存活: 再调 list
  const aliveCheck = await callApi(`window.api.workflow.list()`);
  r.ok(aliveCheck.ok && Array.isArray(aliveCheck.r), 'WF-09b 不存在 template_id 后, list 仍 ok (进程没 crash)', aliveCheck);
} catch (e) {
  r.ok(false, '运行时异常', e.message);
} finally {
  await cleanup();
}

r.summary(() => ws.close());
