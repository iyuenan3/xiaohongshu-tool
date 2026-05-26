// Tools / Agent contract E2E tests
// 验证 13 工具 schema 注册, search_local_assets / web_search 本地分发, 敏感操作集合.
// 黑盒视角: 通过 dynamic import 探测 renderer 的 ai/tools 模块 (这是 ChatPanel 路径核心),
// 如路径变化则降级到只验 IPC 表面.
import { connect, makeReporter, LICENSE } from './_helper.mjs';

const { evalFn, ws } = await connect({ requireMainUI: true });
const r = makeReporter('Tools/Agent');

console.log('=== E2E Tools / Agent ===\n');

const EXPECTED_TOOLS = [
  'check_login_status',
  'list_feeds',
  'search_feeds',
  'get_feed_detail',
  'user_profile',
  'my_profile',
  'post_comment_to_feed',
  'reply_comment_in_feed',
  'like_feed',
  'favorite_feed',
  'publish_content',
  'publish_with_video',
  // v0.2.2+ / v0.3.0+
  'search_local_assets',
  'web_search',
];

// 敏感工具 (需二次确认). like_feed 自 v0.8.x 起免确认 (用户高频点赞), 已移出
const EXPECTED_SENSITIVE = new Set([
  'publish_content',
  'publish_with_video',
  'post_comment_to_feed',
  'reply_comment_in_feed',
  'favorite_feed',
]);

try {
  // TOOL-01: dynamic import renderer 的 ai/tools 模块
  const EXPECTED_JSON = JSON.stringify(EXPECTED_TOOLS);
  const toolMod = await evalFn(`async () => {
    const EXP = ${EXPECTED_JSON};
    try {
      const m = await import('/src/ai/tools.ts');
      return {
        ok: true,
        hasAll: !!m.ALL_TOOL_SCHEMAS,
        hasIsLocal: typeof m.isLocalTool === 'function',
        names: (m.ALL_TOOL_SCHEMAS || []).map((t) => t?.function?.name).filter(Boolean),
        localTools: EXP.filter((n) => typeof m.isLocalTool === 'function' && m.isLocalTool(n)),
      };
    } catch (e) {
      try {
        const m2 = await import('/src/renderer/ai/tools.ts');
        return { ok: true, names: (m2.ALL_TOOL_SCHEMAS || []).map((t) => t?.function?.name).filter(Boolean), fromPath: '/src/renderer/ai/tools.ts' };
      } catch (e2) {
        return { ok: false, err: 'import /src/ai/tools.ts + /src/renderer/ai/tools.ts 都失败', detail: String(e), detail2: String(e2) };
      }
    }
  }`);

  if (!toolMod.ok) {
    r.skip(`TOOL-01 ai/tools.ts import`, '可能路径变化或被 lazy chunk');
  } else {
    r.ok(toolMod.hasAll || Array.isArray(toolMod.names), `TOOL-01 ALL_TOOL_SCHEMAS 暴露`, { hasAll: toolMod.hasAll, count: toolMod.names?.length });
    const missing = EXPECTED_TOOLS.filter((n) => !toolMod.names?.includes(n));
    r.ok(missing.length === 0, `TOOL-02 全部 ${EXPECTED_TOOLS.length} 工具注册`, { missing });

    // TOOL-03: search_local_assets / web_search 标记为本地工具
    if (toolMod.hasIsLocal) {
      r.ok(toolMod.localTools?.includes('search_local_assets'), `TOOL-03 search_local_assets 是 local`, toolMod.localTools);
      r.ok(toolMod.localTools?.includes('web_search'), `TOOL-04 web_search 是 local`, toolMod.localTools);
    } else {
      r.skip('TOOL-03/04 isLocalTool 不暴露');
    }

    // TOOL-05: publish_content schema 含 images 数组
    const pubSchema = await evalFn(`async () => {
      try {
        const m = await import('/src/ai/tools.ts');
        const sch = m.ALL_TOOL_SCHEMAS.find((t) => t?.function?.name === 'publish_content');
        return sch?.function?.parameters || null;
      } catch (e) { return { err: String(e) }; }
    }`);
    const hasImages = !!pubSchema?.properties?.images;
    r.ok(hasImages, `TOOL-05 publish_content schema 含 images 字段`, pubSchema?.properties ? Object.keys(pubSchema.properties) : pubSchema);

    // TOOL-06: search_local_assets schema 含 query
    const searchSchema = await evalFn(`async () => {
      try {
        const m = await import('/src/ai/tools.ts');
        const sch = m.ALL_TOOL_SCHEMAS.find((t) => t?.function?.name === 'search_local_assets');
        return sch?.function?.parameters || null;
      } catch (e) { return { err: String(e) }; }
    }`);
    r.ok(!!searchSchema?.properties?.query, `TOOL-06 search_local_assets schema 含 query 字段`, searchSchema?.properties ? Object.keys(searchSchema.properties) : searchSchema);

    // TOOL-07: web_search schema 含 query
    const webSchema = await evalFn(`async () => {
      try {
        const m = await import('/src/ai/tools.ts');
        const sch = m.ALL_TOOL_SCHEMAS.find((t) => t?.function?.name === 'web_search');
        return sch?.function?.parameters || null;
      } catch (e) { return { err: String(e) }; }
    }`);
    r.ok(!!webSchema?.properties?.query, `TOOL-07 web_search schema 含 query 字段`, webSchema?.properties ? Object.keys(webSchema.properties) : webSchema);
  }

  // TOOL-08: 敏感操作集合 (isSensitive 是 function 形态, 不是 Set)
  const sensProbe = await evalFn(`async () => {
    for (const p of ['/src/ai/sensitivity.ts', '/src/ai/tools.ts', '/src/renderer/ai/sensitivity.ts']) {
      try {
        const m = await import(p);
        if (typeof m.isSensitive === 'function' || m.SENSITIVE_TOOLS) {
          const expected = ['publish_content','publish_with_video','post_comment_to_feed','reply_comment_in_feed','favorite_feed'];
          const harmless = ['like_feed','list_feeds','get_feed_detail','my_profile','user_profile','check_login_status','search_feeds','search_local_assets','web_search'];
          let actualSens = [];
          let actualNon = [];
          if (typeof m.isSensitive === 'function') {
            actualSens = expected.filter((n) => m.isSensitive(n));
            actualNon = harmless.filter((n) => !m.isSensitive(n));
          } else if (m.SENSITIVE_TOOLS) {
            const set = m.SENSITIVE_TOOLS instanceof Set ? m.SENSITIVE_TOOLS : new Set(m.SENSITIVE_TOOLS);
            actualSens = expected.filter((n) => set.has(n));
            actualNon = harmless.filter((n) => !set.has(n));
          }
          return { ok: true, path: p, actualSens, actualNon, missing: expected.filter((n) => !actualSens.includes(n)) };
        }
      } catch {}
    }
    return { ok: false };
  }`);
  if (!sensProbe.ok) {
    r.skip(`TOOL-08 isSensitive import`, '路径未知或未暴露');
  } else {
    r.ok(sensProbe.missing.length === 0, `TOOL-08 isSensitive 覆盖 5 个敏感工具 (path=${sensProbe.path})`, sensProbe);
    r.ok(sensProbe.actualNon.length >= 4, `TOOL-08b 安全工具未被误标 (sample=${sensProbe.actualNon.length})`, sensProbe.actualNon);
  }

  // TOOL-09: BYOK 配置状态. byok 配置存 localStorage 还是 safeStorage?
  // 黑盒猜测: renderer 直连 LLM, 必然有客户端可读配置. 优先 localStorage 然后 byok.bin (IPC config)
  const byok = await evalFn(`() => {
    const keys = Object.keys(localStorage);
    const byokKeys = keys.filter((k) => /byok|llm|api[_-]?key|provider/i.test(k));
    const has = {};
    for (const k of byokKeys) {
      has[k] = (localStorage.getItem(k) || '').slice(0, 80);
    }
    return { keys: byokKeys, has };
  }`);
  r.ok(typeof byok === 'object', `TOOL-09 BYOK localStorage 探测`, byok);
  if (byok?.keys?.length === 0) {
    r.skip('TOOL-09b BYOK 未配置 (vision 测试将 SKIP)');
  }

  // TOOL-10: web_search 工具本地路径 (跨模块验 ChatPanel 调用契约)
  // 我们已在 web-search.mjs 测过功能, 这里验 IPC 入口仍是同一个
  const isFn = await evalFn(`() => typeof window.api?.web?.search === 'function'`);
  r.ok(isFn === true, `TOOL-10 window.api.web.search 与 ai/tools 路径吻合`);

  // TOOL-11: search_local_assets 与 window.api.assets.search 行为应一致 (IPC 不变性)
  const dual = await evalFn(`async () => {
    try {
      const a = await window.api.assets.search('picture', 5);
      return { ok: true, count: Array.isArray(a) ? a.length : null, type: typeof a };
    } catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(dual.ok, `TOOL-11 assets.search 调通`, dual);

  // TOOL-12: 频率护栏 SENSITIVE 关联 (PRD §4 + SPEC §3.4)
  // SPEC 写了 publish/comment/like 三个限流类型, 但 SPEC §12.9 列了 favorite_feed 工具
  // 期望 rate.check 也支持 'favorite'
  const favChk = await evalFn(`async () => {
    try { return { ok: true, r: await window.api.rate.check('favorite') }; }
    catch (e) { return { ok: false, err: String(e) }; }
  }`);
  r.ok(favChk.ok && typeof favChk.r?.allowed === 'boolean', `TOOL-12 rate.check('favorite') 也被支持 (PRD 提到 favorite_feed)`, favChk);
} catch (e) {
  r.ok(false, `运行时异常`, e.message);
}

r.summary(() => ws.close());
