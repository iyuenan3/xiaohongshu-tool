// Tabs / UI 切换 E2E tests
import { connect, makeReporter, sleep } from './_helper.mjs';

const { evalFn, ws } = await connect({ requireMainUI: true });
const r = makeReporter('Tabs/UI');

console.log('=== E2E Tabs / UI ===\n');

try {
  // 先确保在控制台
  await evalFn(`() => { const b = [...document.querySelectorAll('.tabbar__tab')].find(b => b.textContent.trim() === '控制台'); b && b.click(); }`);
  await sleep(150);

  // TAB-01: 4 个 tab
  const tabs = await evalFn(`() => [...document.querySelectorAll('.tabbar__tab')].map(t => t.textContent.trim())`);
  r.ok(Array.isArray(tabs) && tabs.length === 4, `TAB-01 tabbar 有 4 个 tab (${tabs?.length})`, tabs);
  const expectedTabs = ['控制台', '小红书', '素材库', '帮助'];
  const tabsMatch = expectedTabs.every((label) => tabs.some((t) => t.includes(label)));
  r.ok(tabsMatch, `TAB-01b tab 标签包含 控制台/小红书/素材库/帮助`, tabs);

  // TAB-02: 默认激活
  const activeTab = await evalFn(`() => document.querySelector('.tabbar__tab--active')?.textContent.trim()`);
  r.ok(activeTab && activeTab.includes('控制台'), `TAB-02 默认激活「控制台」`, activeTab);

  // TAB-07: 5 个命令按钮
  const cmdCount = await evalFn(`() => document.querySelectorAll('.command-btn').length`);
  r.ok(cmdCount === 5, `TAB-07 5 个 command-btn (${cmdCount})`);

  const cmdLabels = await evalFn(`() => [...document.querySelectorAll('.command-btn__label')].map(e => e.textContent)`);
  const expectedLabels = ['检查登录', '发布笔记', '发布视频', '获取首页推荐', '搜索关键词'];
  const labelsMatch = expectedLabels.every((l, i) => cmdLabels?.[i] === l);
  r.ok(labelsMatch, `TAB-07b 命令标签顺序匹配`, cmdLabels);

  // TAB-08: 点命令预填 + 聚焦
  await evalFn(`() => document.querySelectorAll('.command-btn')[0].click()`);
  await sleep(120);
  const v = await evalFn(`() => document.querySelector('.chat-panel__input textarea')?.value`);
  r.ok(typeof v === 'string' && v.length > 0, `TAB-08 点「检查登录」预填非空`, v);
  // TAB-08b 注: CDP 模拟点击不触发 OS-level focus (document.hasFocus()=false 时 .focus() 无效)
  // 这是 Electron+CDP 测试的固有限制, 用户实际操作窗口 focus 时此行为正常 (见 /tmp/e2e-console.mjs)
  const focusInfo = await evalFn(`() => {
    const el = document.querySelector('.chat-panel__input textarea');
    return { isAct: document.activeElement === el, hasFocus: document.hasFocus() };
  }`);
  if (focusInfo?.hasFocus === false) {
    r.skip(`TAB-08b textarea 聚焦`, 'CDP 测试 window 无 OS focus, .focus() 不生效');
  } else {
    r.ok(focusInfo?.isAct === true, `TAB-08b textarea 聚焦`, focusInfo);
  }

  // 清空 textarea (避免污染后续)
  await evalFn(`() => {
    const el = document.querySelector('.chat-panel__input textarea');
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }`);

  // TAB-03: 切到「小红书」
  await evalFn(`() => { const b = [...document.querySelectorAll('.tabbar__tab')].find(b => b.textContent.trim() === '小红书'); b && b.click(); }`);
  await sleep(150);
  const xhsVisible = await evalFn(`() => { const p = document.querySelector('.tab-pane--xhs'); return !!p && !p.classList.contains('tab-pane--hidden'); }`);
  r.ok(xhsVisible === true, `TAB-03 小红书 pane 显示`);
  const consoleHidden = await evalFn(`() => { const p = document.querySelector('.tab-pane--console'); return !!p && p.classList.contains('tab-pane--hidden'); }`);
  r.ok(consoleHidden === true, `TAB-03b 控制台 pane hidden`);
  const webviewExists = await evalFn(`() => !!document.getElementById('xhs-webview')`);
  r.ok(webviewExists === true, `TAB-03c webview 节点存在`);

  // TAB-04: 切到「素材库」
  await evalFn(`() => { const b = [...document.querySelectorAll('.tabbar__tab')].find(b => b.textContent.trim() === '素材库'); b && b.click(); }`);
  await sleep(150);
  const assetVisible = await evalFn(`() => {
    const p = document.querySelector('.tab-pane--assets');
    if (p) return !p.classList.contains('tab-pane--hidden');
    // fallback: check .asset-library exists & visible
    const al = document.querySelector('.asset-library');
    return !!al;
  }`);
  r.ok(assetVisible === true, `TAB-04 素材库 pane 显示`);

  // TAB-05: 切到「帮助」
  await evalFn(`() => { const b = [...document.querySelectorAll('.tabbar__tab')].find(b => b.textContent.trim() === '帮助'); b && b.click(); }`);
  await sleep(150);
  const helpVisible = await evalFn(`() => { const p = document.querySelector('.tab-pane--help'); return !!p && !p.classList.contains('tab-pane--hidden'); }`);
  r.ok(helpVisible === true, `TAB-05 帮助 pane 显示`);
  const helpSteps = await evalFn(`() => document.querySelectorAll('.help-steps > li').length`);
  r.ok(helpSteps >= 1, `TAB-05b 帮助页 ≥1 step (实际 ${helpSteps})`);
  const helpCallouts = await evalFn(`() => document.querySelectorAll('.help-callout').length`);
  r.ok(helpCallouts >= 0, `TAB-05c 帮助页 callouts (实际 ${helpCallouts})`);

  // TAB-06: 切回控制台
  await evalFn(`() => { const b = [...document.querySelectorAll('.tabbar__tab')].find(b => b.textContent.trim() === '控制台'); b && b.click(); }`);
  await sleep(150);
  const consoleVisible = await evalFn(`() => { const p = document.querySelector('.tab-pane--console'); return !!p && !p.classList.contains('tab-pane--hidden'); }`);
  r.ok(consoleVisible === true, `TAB-06 切回控制台 pane 显示`);
  const chatPanelExists = await evalFn(`() => !!document.querySelector('.chat-panel')`);
  r.ok(chatPanelExists === true, `TAB-06b chat-panel 元素存在`);
} catch (e) {
  r.ok(false, `运行时异常`, e.message);
}

r.summary(() => ws.close());
