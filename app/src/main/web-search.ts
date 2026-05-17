// 联网搜索: 用隐藏 BrowserWindow + executeJavaScript 抓搜狗 SERP
//
// 为什么不用 cheerio: Electron 内置 Chromium, 真 DOM + 真 Chrome UA + 真 cookies,
// 反爬绕过率最高; 0 额外依赖. 代价是每次搜索开 hidden window ~1-2s, LLM agent
// 调用本就慢, 体感可接受.
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
    return await searchSogou(query, n, timeoutMs);
  } finally {
    release();
  }
}

async function searchSogou(query: string, n: number, timeoutMs: number): Promise<WebSearchResult[]> {
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
  // 真实 Chrome UA, Electron 默认会带 Electron/x.y, 会被搜狗识别
  win.webContents.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  );

  const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`;
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
    log.info(`[web-search] sogou "${query}" → ${results.length} 条`);
    if (!results || results.length === 0) {
      return [{ title: '无结果', url: '', snippet: '搜狗未返回有效结果' }];
    }
    return results.slice(0, n);
  } catch (e) {
    log.warn(`[web-search] sogou "${query}" failed:`, e);
    return [{ title: '搜索失败', url: '', snippet: String(e).slice(0, 200) }];
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

// 在 search page 内执行的提取函数 (字符串形式, 避开 main 进程 TS dom 类型检查)
const EXTRACT_JS = `
(function(n) {
  const out = [];
  const nodes = document.querySelectorAll('div.vrwrap');
  for (let i = 0; i < nodes.length && out.length < n; i++) {
    const d = nodes[i];
    const titleEl = d.querySelector('h3');
    const title = (titleEl && titleEl.textContent || '').trim();
    if (!title) continue;
    const aEl = d.querySelector('a');
    const url = aEl ? aEl.href : '';
    const snipEl = d.querySelector('.space-txt, p');
    const snippet = ((snipEl && snipEl.textContent || '').trim()).slice(0, 300);
    out.push({ title: title, url: url, snippet: snippet });
  }
  return out;
})
`;
