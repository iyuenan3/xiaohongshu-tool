// 联网搜索: 用隐藏 BrowserWindow + executeJavaScript 抓 DuckDuckGo HTML SERP
//
// 历史: v0.3.0 用搜狗 (div.vrwrap), 2026-05-20 v0.7 切 DuckDuckGo (sogou 改版后选择器失效).
//
// 为什么不用 cheerio: Electron 内置 Chromium, 真 DOM + 真 Chrome UA + 真 cookies,
// 反爬绕过率最高; 0 额外依赖. 代价是每次搜索开 hidden window ~1-2s, LLM agent
// 调用本就慢, 体感可接受.
//
// 为什么 DuckDuckGo (`html.duckduckgo.com/html/`): 无需 JS, 国内能直连 (CF anycast),
// 页面 DOM 稳定. 跟 CLAUDE.md 全局规约 (DuckDuckGo 优先) 一致.
//
// 串行化 (mutex): 同时只跑 1 个搜索, 防 LLM 短时间多次调爆 fd.

import { BrowserWindow } from 'electron';
import log from 'electron-log/main';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

let searchLock: Promise<void> = Promise.resolve();

/** 公开入口: 串行化包装. */
export async function searchWeb(query: string, n = 5, timeoutMs = 15000): Promise<WebSearchResult[]> {
  let release!: () => void;
  const waiter = new Promise<void>((r) => { release = r; });
  const prev = searchLock;
  searchLock = waiter;
  await prev;
  try {
    return await searchDuckDuckGo(query, n, timeoutMs);
  } finally {
    release();
  }
}

async function searchDuckDuckGo(query: string, n: number, timeoutMs: number): Promise<WebSearchResult[]> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // 不带 preload (避免 contextBridge 注入到搜索页)
    },
  });
  // 真实 Chrome UA, Electron 默认会带 Electron/x.y, 会被反爬识别
  win.webContents.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  );

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const loadP = win.loadURL(url);
    const timeoutP = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`load timeout ${timeoutMs}ms`)), timeoutMs),
    );
    await Promise.race([loadP, timeoutP]);

    // 等 DOM 稳定 (页面加载完后 JS 可能再补内容)
    await new Promise((r) => setTimeout(r, 400));

    const js = `${EXTRACT_JS}(${n})`;
    const results = (await win.webContents.executeJavaScript(js)) as WebSearchResult[];
    log.info(`[web-search] duckduckgo "${query}" → ${results.length} 条`);
    if (!results || results.length === 0) {
      return [{ title: '无结果', url: '', snippet: 'DuckDuckGo 未返回有效结果' }];
    }
    return results.slice(0, n);
  } catch (e) {
    log.warn(`[web-search] duckduckgo "${query}" failed:`, e);
    return [{ title: '搜索失败', url: '', snippet: String(e).slice(0, 200) }];
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

// 在 search page 内执行的提取函数 (字符串形式, 避开 main 进程 TS dom 类型检查)
// DuckDuckGo HTML SERP 结构: <div class="result results_links ...">
//   <h2 class="result__title"><a class="result__a" href="...">title</a></h2>
//   <a class="result__snippet" href="...">snippet</a>
// </div>
//
// 注意 DDG 用 redirect URL (//duckduckgo.com/l/?uddg=<encoded>), 提取真实 URL.
const EXTRACT_JS = `
(function(n) {
  const out = [];
  const nodes = document.querySelectorAll('div.result, div.web-result');
  for (let i = 0; i < nodes.length && out.length < n; i++) {
    const d = nodes[i];
    const aEl = d.querySelector('a.result__a, h2 a, .result__title a');
    const title = (aEl && aEl.textContent || '').trim();
    if (!title) continue;
    let url = aEl ? aEl.href : '';
    try {
      if (url && url.indexOf('duckduckgo.com/l/') >= 0) {
        const u = new URL(url, location.origin);
        const real = u.searchParams.get('uddg');
        if (real) url = real;
      }
    } catch (e) { /* ignore parse err */ }
    const snipEl = d.querySelector('.result__snippet, .snippet, .result__body');
    const snippet = ((snipEl && snipEl.textContent || '').trim()).slice(0, 300);
    out.push({ title: title, url: url, snippet: snippet });
  }
  return out;
})
`;
