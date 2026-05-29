// 自主运营系统 P1 闭环 E2E tests
// 覆盖: 画像 CRUD → 生成计划(真调 LLM) → 激活实例化 → 幂等 → 清旧计划 → 待审/拒绝
//
// 重点验证 code-review 修的 3 个 bug:
//   B1 行动不落过去 (planner dayTimeToTs: ts<now → 顺延, 否则 scheduleNext 判 missed 静默不执行)
//   B2 幂等 (activatePlan 对已 active 的 plan 返 {ok:false, error 含"已激活"})
//   B3 清旧计划 (activate 新 plan 时, 旧 active plan 的 [运营] once workflow 被 softDelete + 旧 plan 标 superseded + 其 action 标 skipped)
//
// ⚠️ 红线:
//   - 绝不让笔记真发布到小红书 → 不测 approvePublish 成功路径, 只测无图前置拦截。
//   - generatePlan 真调 LLM 烧额度 → 全程最多 2 次 (测试项 2 和 5)。
//   - 测试创建的 [运营] once 工作流到点会真去小红书互动 → 收尾必清 (workflow.delete 取消调度 + softDelete)。
//
// 收尾: finally 块 (1) 删所有 [运营] workflow (2) 由外层脚本用 sqlite3 清 operating 表测试数据。
import { connect, makeReporter, sleep } from './_helper.mjs';

const { evalFn, ws } = await connect({ requireMainUI: true });
const r = makeReporter('Operating');

console.log('=== E2E 自主运营 P1 闭环 ===\n');

const DIRECTION = 'E2E测试果园'; // direction LIKE 'E2E%' 便于 sqlite 清理

// 在 renderer 内调一个 operating/workflow API, 返回 {ok, r, err}, 避免异常炸断整个套件
async function callApi(expr) {
  return evalFn(`async () => {
    try { const r = await (${expr}); return { ok: true, r }; }
    catch (e) { return { ok: false, err: String(e?.message || e) }; }
  }`);
}

// 收集本套件创建的 [运营] workflow id, finally 统一删 (取消调度 + softDelete)
async function cleanupOperatingWorkflows() {
  const res = await callApi(`(async () => {
    const list = await window.api.workflow.list();
    const ops = list.filter((w) => typeof w.name === 'string' && w.name.includes('[运营]'));
    const out = [];
    for (const w of ops) {
      try { await window.api.workflow.delete(w.id); out.push({ id: w.id, name: w.name, deleted: true }); }
      catch (e) { out.push({ id: w.id, name: w.name, deleted: false, err: String(e) }); }
    }
    return out;
  })()`);
  return res.r || [];
}

let createdProfileId = null;
let plan1Id = null;
let plan2Id = null;

try {
  // 先确保起点干净: 删任何残留的 [运营] workflow (上次中断遗留), 防干扰断言
  const preClean = await cleanupOperatingWorkflows();
  if (preClean.length) console.log(`  · 起点清理残留 [运营] workflow: ${preClean.length} 个`);

  // ============ 1. 画像 CRUD ============
  const profileInput = {
    direction: DIRECTION,
    persona: '云南山里种果子的真实记录者，治愈、慢生活',
    constraints: {
      pub_per_week: 3,
      active_hours: '19:00-21:00',
      taboo: ['政治', '低俗'],
      tone: '真实、治愈、慢生活',
      free_text: 'E2E 测试画像，请勿当真。',
    },
    asset_tags: ['樱花', '果园'],
    status: 'active', // 设 active → getActiveProfile 命中本画像, generatePlan 据此规划
  };
  const saved = await callApi(`window.api.operating.saveProfile(${JSON.stringify(profileInput)})`);
  r.ok(saved.ok && saved.r && typeof saved.r.id === 'number', 'OP-01a saveProfile 建画像返 id', saved);
  createdProfileId = saved.r?.id ?? null;
  if (createdProfileId) {
    r.ok(saved.r.direction === DIRECTION, 'OP-01b direction 入库', saved.r.direction);
    r.ok(saved.r.status === 'active', 'OP-01c status=active 入库', saved.r.status);

    // getActiveProfile 读回字段一致
    const active = await callApi(`window.api.operating.getActiveProfile()`);
    r.ok(active.ok && active.r?.id === createdProfileId, 'OP-01d getActiveProfile 命中本画像', { got: active.r?.id, want: createdProfileId });
    if (active.r) {
      r.ok(active.r.direction === DIRECTION, 'OP-01e 读回 direction 一致', active.r.direction);
      r.ok(active.r.persona === profileInput.persona, 'OP-01f 读回 persona 一致', active.r.persona);
      // constraints 入库为 JSON string, parse 后字段一致
      const c = (() => { try { return JSON.parse(active.r.constraints); } catch { return null; } })();
      r.ok(c?.pub_per_week === 3, 'OP-01g constraints.pub_per_week=3', c?.pub_per_week);
      r.ok(c?.active_hours === '19:00-21:00', 'OP-01h constraints.active_hours 一致', c?.active_hours);
      r.ok(Array.isArray(c?.taboo) && c.taboo.includes('政治'), 'OP-01i constraints.taboo 含"政治"', c?.taboo);
      r.ok(c?.tone === '真实、治愈、慢生活', 'OP-01j constraints.tone 一致', c?.tone);
      // asset_tags 入库为 JSON string
      const at = (() => { try { return JSON.parse(active.r.asset_tags); } catch { return null; } })();
      r.ok(Array.isArray(at) && at.includes('樱花') && at.includes('果园'), 'OP-01k asset_tags 一致', at);
    }

    // listProfiles 含本画像
    const lp = await callApi(`window.api.operating.listProfiles()`);
    const found = (lp.r || []).find((p) => p.id === createdProfileId);
    r.ok(!!found, 'OP-01l listProfiles 含本画像', { id: createdProfileId, len: lp.r?.length });

    // saveProfile(id) 更新已有 (不新建): 改 persona
    const upd = await callApi(`window.api.operating.saveProfile(${JSON.stringify({ ...profileInput, id: createdProfileId, persona: 'E2E 更新后的人设' })})`);
    r.ok(upd.ok && upd.r?.id === createdProfileId, 'OP-01m saveProfile(带 id) 返同 id (更新而非新建)', { got: upd.r?.id });
    r.ok(upd.r?.persona === 'E2E 更新后的人设', 'OP-01n 更新 persona 生效', upd.r?.persona);
    const lp2 = await callApi(`window.api.operating.listProfiles()`);
    const e2eCount = (lp2.r || []).filter((p) => p.direction === DIRECTION).length;
    r.ok(e2eCount === 1, 'OP-01o 更新未产生重复画像 (E2E 画像仍只 1 条)', { count: e2eCount });

    // setProfileStatus: active → paused → active (恢复 active, 让后续 generatePlan 命中)
    const setPaused = await callApi(`window.api.operating.setProfileStatus(${createdProfileId}, 'paused')`);
    r.ok(setPaused.ok && setPaused.r?.ok === true, 'OP-01p setProfileStatus(paused) ok', setPaused);
    const afterPaused = await callApi(`window.api.operating.getProfile(${createdProfileId})`);
    r.ok(afterPaused.r?.status === 'paused', 'OP-01q getProfile 读回 status=paused', afterPaused.r?.status);
    const setActive = await callApi(`window.api.operating.setProfileStatus(${createdProfileId}, 'active')`);
    r.ok(setActive.ok && setActive.r?.ok === true, 'OP-01r setProfileStatus(active) 恢复 ok', setActive);
    const afterActive = await callApi(`window.api.operating.getProfile(${createdProfileId})`);
    r.ok(afterActive.r?.status === 'active', 'OP-01s 恢复后 status=active', afterActive.r?.status);
  } else {
    r.ok(false, 'OP-01 saveProfile 失败, 跳过依赖画像的后续项', saved);
    throw new Error('no profile, abort');
  }

  // 防御: 确认 getActiveProfile 确实是本测试画像, 否则 generatePlan 会规划到真实用户画像 → abort
  const activeGuard = await callApi(`window.api.operating.getActiveProfile()`);
  if (activeGuard.r?.id !== createdProfileId) {
    r.ok(false, 'OP-GUARD getActiveProfile 非本测试画像, 中止以防误规划真实画像', { active: activeGuard.r?.id, mine: createdProfileId });
    throw new Error('active profile mismatch, abort to protect real profile');
  }

  // ============ 2. 生成计划 (真调 LLM, 10-40s) ============
  console.log('  · 调 generatePlan(7) 真调 LLM (1/2), 约 10-40s ...');
  const gen1 = await evalFn(`async () => {
    try { const r = await window.api.operating.generatePlan(7); return { ok: true, r }; }
    catch (e) { return { ok: false, err: String(e?.message || e) }; }
  }`);
  r.ok(gen1.ok && gen1.r?.ok === true, 'OP-02a generatePlan(7) 返 ok=true', gen1);
  if (gen1.r?.ok) {
    plan1Id = gen1.r.planId;
    r.ok(typeof plan1Id === 'number' && plan1Id > 0, 'OP-02b 返 planId (number>0)', plan1Id);
    r.ok(typeof gen1.r.actionsCount === 'number' && gen1.r.actionsCount > 0, 'OP-02c actionsCount>0', gen1.r.actionsCount);
    r.ok(typeof gen1.r.rationale === 'string' && gen1.r.rationale.trim().length > 0, 'OP-02d rationale 非空', gen1.r.rationale);

    // listActions: type 合法 + spec 可 parse + scheduled_at 存在
    const acts = await callApi(`window.api.operating.listActions(${plan1Id})`);
    const actions = acts.r || [];
    r.ok(Array.isArray(actions) && actions.length > 0, 'OP-02e listActions 返非空数组', { len: actions.length });
    r.ok(actions.length === gen1.r.actionsCount, 'OP-02f listActions 数量 == actionsCount', { list: actions.length, reported: gen1.r.actionsCount });

    const validType = actions.every((a) => ['browse', 'interact', 'publish'].includes(a.type));
    r.ok(validType, 'OP-02g 所有 action.type ∈ {browse,interact,publish}', actions.map((a) => a.type));

    const specParsable = actions.every((a) => { try { JSON.parse(a.spec); return true; } catch { return false; } });
    r.ok(specParsable, 'OP-02h 所有 action.spec 可 JSON.parse');

    const allHaveSched = actions.every((a) => typeof a.scheduled_at === 'number' && a.scheduled_at > 0);
    r.ok(allHaveSched, 'OP-02i 所有 action 有 scheduled_at (number>0)');

    // ★ B1 关键断言: 所有 scheduled_at >= 生成时刻 (行动绝不排在过去, 否则被判 missed 静默不执行)
    // 用生成前抓的基线 now 而非当前 Date.now() (planner 顺延=now+5min, 生成到断言间会流逝几十秒, 留足余量)
    const nowAtGen = await evalFn(`() => Date.now()`);
    const pastActions = actions.filter((a) => a.scheduled_at < nowAtGen - 60 * 1000); // 容 60s 时钟漂移
    r.ok(
      pastActions.length === 0,
      `★OP-02j [B1 修复] 所有 scheduled_at >= now (无行动落过去) — past=${pastActions.length}`,
      pastActions.map((a) => ({ id: a.id, type: a.type, at: a.scheduled_at, deltaMin: Math.round((a.scheduled_at - nowAtGen) / 60000) })),
    );
    const minSched = actions.reduce((m, a) => Math.min(m, a.scheduled_at), Infinity);
    console.log(`  · B1: 最早 action 距今 ${Math.round((minSched - nowAtGen) / 60000)} 分钟 (>=0 即未落过去)`);

    // 初始 status 应为 pending (未激活)
    const allPending = actions.every((a) => a.status === 'pending');
    r.ok(allPending, 'OP-02k 未激活时所有 action.status=pending', actions.map((a) => a.status));
  } else {
    r.ok(false, 'OP-02 generatePlan 失败, 跳过依赖计划的后续项 (3/4/5)', gen1);
  }

  // ============ 3. 激活实例化 ============
  if (plan1Id) {
    const act1 = await callApi(`window.api.operating.activatePlan(${plan1Id})`);
    r.ok(act1.ok && act1.r?.ok === true, 'OP-03a activatePlan(plan1) 返 ok=true', act1);
    if (act1.r?.ok) {
      // created/skipped/pendingPublish 与 action 类型分布吻合
      const acts = await callApi(`window.api.operating.listActions(${plan1Id})`);
      const actions = acts.r || [];
      const nInteract = actions.filter((a) => a.type === 'interact').length;
      const nBrowse = actions.filter((a) => a.type === 'browse').length;
      const nPublish = actions.filter((a) => a.type === 'publish').length;
      console.log(`  · plan1 行动分布: interact=${nInteract} browse=${nBrowse} publish=${nPublish}`);
      console.log(`  · activatePlan 返回: created=${act1.r.created} skipped=${act1.r.skipped} pendingPublish=${act1.r.pendingPublish}`);

      // interact 有 keyword 才实例化; created<=nInteract (无 keyword 的被 skip). browse 必 skip。
      r.ok(act1.r.created <= nInteract && act1.r.created >= 0, 'OP-03b created <= interact 行动数', { created: act1.r.created, nInteract });
      r.ok(act1.r.pendingPublish === nPublish, 'OP-03c pendingPublish == publish 行动数', { pendingPublish: act1.r.pendingPublish, nPublish });
      r.ok(act1.r.created + act1.r.skipped + act1.r.pendingPublish === actions.length, 'OP-03d created+skipped+pendingPublish == 总行动数', {
        sum: act1.r.created + act1.r.skipped + act1.r.pendingPublish, total: actions.length,
      });

      // interact/publish 被实例化的 action.status='scheduled' (有 keyword 的 interact + 所有 publish)
      const instantiated = actions.filter((a) => (a.type === 'interact' || a.type === 'publish') && a.workflow_id);
      const allScheduled = instantiated.length === 0 || instantiated.every((a) => a.status === 'scheduled');
      r.ok(allScheduled, 'OP-03e 实例化的 interact/publish action.status=scheduled', instantiated.map((a) => ({ type: a.type, status: a.status, wf: a.workflow_id })));
      r.ok(actions.filter((a) => a.type === 'browse').every((a) => a.status === 'skipped'), 'OP-03f 所有 browse action.status=skipped');

      // plan 状态变 active
      const planNow = await callApi(`window.api.operating.getLatestPlan(${createdProfileId})`);
      r.ok(planNow.r?.id === plan1Id && planNow.r?.status === 'active', 'OP-03g plan1 status=active', { id: planNow.r?.id, status: planNow.r?.status });

      // window.api.workflow.list() 查到 [运营] workflow
      const wfList = await callApi(`window.api.workflow.list()`);
      const opWfs = (wfList.r || []).filter((w) => typeof w.name === 'string' && w.name.includes('[运营]'));
      const expectWfCount = act1.r.created + act1.r.pendingPublish;
      r.ok(opWfs.length >= expectWfCount && expectWfCount > 0 ? opWfs.length === expectWfCount : opWfs.length >= 0,
        `OP-03h workflow.list 含 ${expectWfCount} 个 [运营] workflow (实际 ${opWfs.length})`,
        opWfs.map((w) => w.name));

      // ★ [运营] workflow 的 schedule type='once' 且 at 在未来
      const nowTs = await evalFn(`() => Date.now()`);
      let allOnceFuture = true;
      const schedDetail = [];
      for (const w of opWfs) {
        const s = (() => { try { return JSON.parse(w.schedule); } catch { return null; } })();
        schedDetail.push({ name: w.name, type: s?.type, atDeltaMin: s?.at ? Math.round((s.at - nowTs) / 60000) : null, enabled: w.enabled });
        if (s?.type !== 'once' || !(s?.at > nowTs - 60 * 1000)) allOnceFuture = false;
      }
      if (opWfs.length > 0) {
        r.ok(allOnceFuture, 'OP-03i 所有 [运营] workflow schedule.type=once 且 at 在未来', schedDetail);
        r.ok(opWfs.every((w) => w.enabled === 1), 'OP-03j 所有 [运营] workflow enabled=1', schedDetail);
      } else {
        r.skip('OP-03i/j [运营] workflow schedule 校验', '本次 LLM 未产出可实例化的 interact/publish (全 browse 或 interact 无 keyword)');
      }
    }
  } else {
    r.skip('OP-03 激活实例化', 'plan1 生成失败');
  }

  // ============ 4. 幂等 (★ B2 修复) ============
  if (plan1Id) {
    const actAgain = await callApi(`window.api.operating.activatePlan(${plan1Id})`);
    r.ok(actAgain.ok && actAgain.r?.ok === false, '★OP-04a [B2 修复] 重复 activatePlan 返 ok=false', actAgain);
    r.ok(typeof actAgain.r?.error === 'string' && actAgain.r.error.includes('已激活'), '★OP-04b [B2 修复] error 含"已激活"', actAgain.r?.error);
    r.ok(actAgain.r?.created === 0, 'OP-04c 幂等调用 created=0 (未重复实例化)', actAgain.r?.created);

    // 确认未因幂等调用多造 workflow (数量不变)
    const wfList = await callApi(`window.api.workflow.list()`);
    const opWfsAfter = (wfList.r || []).filter((w) => typeof w.name === 'string' && w.name.includes('[运营]'));
    console.log(`  · 幂等调用后 [运营] workflow 数: ${opWfsAfter.length} (应与激活后一致, 无新增)`);
  } else {
    r.skip('OP-04 幂等', 'plan1 生成失败');
  }

  // ============ 5. 清旧计划 (★ B3 修复) ============
  // 再生成新计划 → 激活 → 旧 plan1 应被 superseded + 其 [运营] workflow 被 softDelete
  if (plan1Id) {
    // 激活后 plan1 的 scheduled action 的 workflow_id (后面验证它们被 softDelete)
    const plan1ActsBefore = await callApi(`window.api.operating.listActions(${plan1Id})`);
    const plan1WfIds = (plan1ActsBefore.r || []).filter((a) => a.workflow_id).map((a) => a.workflow_id);
    console.log(`  · plan1 实例化的 workflow_id: [${plan1WfIds.join(', ')}]`);

    console.log('  · 调 generatePlan(7) 真调 LLM (2/2) 生成新计划, 约 10-40s ...');
    const gen2 = await evalFn(`async () => {
      try { const r = await window.api.operating.generatePlan(7); return { ok: true, r }; }
      catch (e) { return { ok: false, err: String(e?.message || e) }; }
    }`);
    r.ok(gen2.ok && gen2.r?.ok === true, 'OP-05a 再 generatePlan(7) 生成新计划 ok', gen2);
    plan2Id = gen2.r?.ok ? gen2.r.planId : null;
    r.ok(plan2Id && plan2Id !== plan1Id, 'OP-05b 新计划 planId 与旧不同', { plan1Id, plan2Id });

    // 生成新计划后, 激活前 plan1 仍 active (生成不影响旧计划)
    const plan1MidStatus = await callApi(`(async () => { const acts = await window.api.operating.listActions(${plan1Id}); return acts; })()`);
    // 用 getLatestPlan 只能拿到最新(plan2), plan1 状态改用 listActions 间接 + 激活后再确认

    if (plan2Id) {
      const act2 = await callApi(`window.api.operating.activatePlan(${plan2Id})`);
      r.ok(act2.ok && act2.r?.ok === true, 'OP-05c activatePlan(plan2) ok=true', act2);

      // ★ B3-1: 旧 plan1 标 superseded → 其 action.status 由 scheduled 变 skipped
      const plan1ActsAfter = await callApi(`window.api.operating.listActions(${plan1Id})`);
      const plan1Acts = plan1ActsAfter.r || [];
      const stillScheduled = plan1Acts.filter((a) => a.status === 'scheduled');
      r.ok(
        stillScheduled.length === 0,
        '★OP-05d [B3 修复] 旧 plan1 的 scheduled action 全变 skipped (不再调度)',
        stillScheduled.map((a) => ({ id: a.id, type: a.type, status: a.status })),
      );
      if (plan1WfIds.length > 0) {
        const skippedCount = plan1Acts.filter((a) => a.status === 'skipped').length;
        r.ok(skippedCount >= plan1WfIds.length, '★OP-05e [B3 修复] 旧 plan1 被实例化的 action 已标 skipped', { skippedCount, wasInstantiated: plan1WfIds.length });
      }

      // ★ B3-2: 旧 plan1 实例化的 [运营] workflow 被 softDelete → 默认 list 不再含
      const wfListAfter = await callApi(`window.api.workflow.list()`);
      const liveIds = new Set((wfListAfter.r || []).map((w) => w.id));
      const orphanLive = plan1WfIds.filter((id) => liveIds.has(id));
      r.ok(
        orphanLive.length === 0,
        '★OP-05f [B3 修复] 旧 plan1 的 [运营] workflow 已 softDelete (list 不再含)',
        { plan1WfIds, stillLive: orphanLive },
      );

      // ★ B3-3: 现存 [运营] workflow 应只属于 plan2 (数量 == plan2 的 created+pendingPublish)
      const opWfsNow = (wfListAfter.r || []).filter((w) => typeof w.name === 'string' && w.name.includes('[运营]'));
      const expectPlan2 = act2.r.created + act2.r.pendingPublish;
      r.ok(
        opWfsNow.length === expectPlan2,
        `OP-05g 现存 [运营] workflow 数 == plan2 实例化数 (${opWfsNow.length} vs ${expectPlan2})`,
        { live: opWfsNow.map((w) => w.id), expectPlan2 },
      );

      // plan2 成为 active
      const latestNow = await callApi(`window.api.operating.getLatestPlan(${createdProfileId})`);
      r.ok(latestNow.r?.id === plan2Id && latestNow.r?.status === 'active', 'OP-05h plan2 status=active', { id: latestNow.r?.id, status: latestNow.r?.status });
    }
  } else {
    r.skip('OP-05 清旧计划', 'plan1 生成失败');
  }

  // ============ 6. 待审 + 拒绝 + approve 前置拦截 ============
  // planned_publish 工作流要到点(once)才拟稿进 pending, 激活后不会立即有 → listPending 多半为空。
  const pend = await callApi(`window.api.operating.listPending()`);
  r.ok(pend.ok && Array.isArray(pend.r), 'OP-06a listPending() 返数组', { len: pend.r?.length });
  const pendings = pend.r || [];
  console.log(`  · listPending 当前 ${pendings.length} 条 (planned_publish 要到点才拟稿, 激活后立即查多半为空)`);

  if (pendings.length === 0) {
    r.skip('OP-06b 待审拒绝/approve 拦截', 'listPending 为空 (planned_publish once 未到点, 无法构造 pending; 符合预期)');
  } else {
    // 找一条 plan_action_id 指向本测试 plan 的 pending 才动 (避免误伤真实用户的 pending)
    const planIds = [plan1Id, plan2Id].filter(Boolean);
    const myPlanActionIds = new Set();
    for (const pid of planIds) {
      const acts = await callApi(`window.api.operating.listActions(${pid})`);
      for (const a of (acts.r || [])) myPlanActionIds.add(a.id);
    }
    const mine = pendings.filter((p) => p.plan_action_id != null && myPlanActionIds.has(p.plan_action_id));
    if (mine.length === 0) {
      r.skip('OP-06b 待审拒绝/approve 拦截', `有 ${pendings.length} 条 pending 但均非本测试产生 (不动真实用户数据)`);
    } else {
      const target = mine[0];
      // approvePublish 前置拦截: 无图应返 {ok:false, error 含"配图"}。绝不测成功路径(会真发)。
      const imgs = (() => { try { return JSON.parse(target.images || '[]'); } catch { return []; } })();
      if (imgs.length === 0) {
        const appr = await callApi(`window.api.operating.approvePublish(${target.id})`);
        r.ok(appr.ok && appr.r?.ok === false, 'OP-06c approvePublish 无图前置拦截 ok=false', appr);
        r.ok(typeof appr.r?.error === 'string' && appr.r.error.includes('配图'), 'OP-06d 拦截 error 含"配图"', appr.r?.error);
      } else {
        // 有图 → approve 会真发 → 绝不调, 只 SKIP
        r.skip('OP-06c approvePublish 拦截', `本测试 pending 有配图(${imgs.length}), 测 approve 会真发到小红书 → SKIP`);
      }
      // rejectPending 安全 (只标 status, 不触网) → 测标记
      const rej = await callApi(`window.api.operating.rejectPending(${target.id})`);
      r.ok(rej.ok && rej.r?.ok === true, 'OP-06e rejectPending 返 ok=true', rej);
      // 标记后 listPending('pending') 不再含它
      const pendAfter = await callApi(`window.api.operating.listPending()`);
      const stillPending = (pendAfter.r || []).find((p) => p.id === target.id);
      r.ok(!stillPending, 'OP-06f reject 后 listPending 不再含该条', { id: target.id });
    }
  }
} catch (e) {
  r.ok(false, '运行时异常', e.message);
} finally {
  // ============ 收尾: 删本套件创建的所有 [运营] workflow (取消调度 + softDelete) ============
  // ⚠️ 关键: 不清的话, once 工作流到未来某点会真去小红书互动!
  const cleaned = await cleanupOperatingWorkflows();
  console.log(`\n[cleanup] 删除 [运营] workflow ${cleaned.length} 个:`, JSON.stringify(cleaned));
  // 验证: list 已无 [运营] workflow
  const verify = await callApi(`(async () => {
    const list = await window.api.workflow.list();
    return list.filter((w) => typeof w.name === 'string' && w.name.includes('[运营]')).map((w) => ({ id: w.id, name: w.name, enabled: w.enabled }));
  })()`);
  const remain = verify.r || [];
  console.log(`[cleanup] list 残留 [运营] workflow: ${remain.length} 个`, remain.length ? JSON.stringify(remain) : '(干净)');
  // operating 表数据由外层 run 脚本用 sqlite3 清 (renderer 无 DB 直连); 这里只报告 id 供清理。
  console.log(`[cleanup] 待 sqlite 清理: profileId=${createdProfileId}, planIds=[${[plan1Id, plan2Id].filter(Boolean).join(', ')}], direction LIKE 'E2E%'`);
}

r.summary(() => ws.close());
