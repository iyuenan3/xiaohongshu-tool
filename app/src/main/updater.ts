import { app, dialog, BrowserWindow, clipboard } from 'electron';
import log from 'electron-log/main';

// 中间路线: 不 auto-update, 启动 8s 后调 Worker /version, 有新版弹 dialog 让用户联系客服获取最新包
// 跟 license.ts 共用同一个 Worker base
const WORKER_URL = process.env.XHS_WORKER_URL ?? 'https://xhslicense.maxwellii.com';
const CHECK_DELAY_MS = 8 * 1000;
const FETCH_TIMEOUT_MS = 8 * 1000;

let mainWindowGetter: (() => BrowserWindow | null) | null = null;
let didPromptThisSession = false;

interface VersionResp {
  ok: boolean;
  latest_version?: string;
  min_version?: string;
  support_contact?: string;
  release_notes?: string;
}

export function initUpdater(getMainWindow: () => BrowserWindow | null): void {
  mainWindowGetter = getMainWindow;
  if (!app.isPackaged) {
    log.info('[updater] dev mode, skipping update check');
    return;
  }
  setTimeout(() => {
    void runCheck({ manual: false });
  }, CHECK_DELAY_MS);
}

export function stopUpdater(): void {
  // 无定时器, noop. 保留 export 以兼容 main/index.ts before-quit
}

export async function checkForUpdatesNow(): Promise<{
  ok: boolean;
  current?: string;
  latest?: string;
  newer?: boolean;
  message?: string;
}> {
  return await runCheck({ manual: true });
}

async function runCheck(opts: { manual: boolean }): Promise<{
  ok: boolean;
  current?: string;
  latest?: string;
  newer?: boolean;
  message?: string;
}> {
  const current = app.getVersion();
  let resp: VersionResp;
  try {
    const r = await fetchWithTimeout(`${WORKER_URL}/version`, FETCH_TIMEOUT_MS);
    if (!r.ok) {
      const msg = `HTTP ${r.status}`;
      log.warn(`[updater] /version ${msg}`);
      if (opts.manual) await alertError(`检查更新失败: ${msg}`);
      return { ok: false, current, message: msg };
    }
    resp = (await r.json()) as VersionResp;
  } catch (e) {
    const msg = String(e);
    log.warn(`[updater] /version fetch error: ${msg}`);
    if (opts.manual) await alertError('检查更新失败,请检查网络');
    return { ok: false, current, message: msg };
  }

  if (!resp.ok || !resp.latest_version) {
    log.warn('[updater] /version invalid response');
    if (opts.manual) await alertError('检查更新失败: 服务端响应异常');
    return { ok: false, current, message: 'invalid response' };
  }

  const latest = resp.latest_version;
  const newer = isNewer(latest, current);
  log.info(`[updater] current=${current} latest=${latest} newer=${newer}`);

  if (!newer) {
    if (opts.manual) {
      const win = mainWindowGetter?.();
      if (win && !win.isDestroyed()) {
        await dialog.showMessageBox(win, {
          type: 'info',
          title: '已是最新版本',
          message: `当前版本 v${current} 已是最新`,
          buttons: ['好的'],
        });
      }
    }
    return { ok: true, current, latest, newer: false };
  }

  // 自动检查每个 session 只弹一次, 手动 check 不受限
  if (!opts.manual && didPromptThisSession) {
    return { ok: true, current, latest, newer: true };
  }

  const win = mainWindowGetter?.();
  if (!win || win.isDestroyed()) {
    return { ok: true, current, latest, newer: true };
  }

  if (!opts.manual) didPromptThisSession = true;

  const contact = resp.support_contact ?? '微信: maxwellii';
  const notes = (resp.release_notes ?? '').trim();
  const detailLines = [
    notes ? `更新内容:\n${notes}` : null,
    `请联系客服获取最新安装包:\n${contact}`,
  ].filter(Boolean) as string[];

  const result = await dialog.showMessageBox(win, {
    type: 'info',
    title: '发现新版本',
    message: `v${latest} 已发布 (当前 v${current})`,
    detail: detailLines.join('\n\n'),
    buttons: ['复制联系方式', '稍后再说'],
    defaultId: 0,
    cancelId: 1,
  });

  if (result.response === 0) {
    clipboard.writeText(contact);
    await dialog.showMessageBox(win, {
      type: 'info',
      title: '已复制',
      message: '联系方式已复制到剪贴板',
      detail: '请打开微信添加客服获取最新版本。',
      buttons: ['好的'],
    });
  }

  return { ok: true, current, latest, newer: true };
}

async function alertError(message: string): Promise<void> {
  const win = mainWindowGetter?.();
  if (!win || win.isDestroyed()) return;
  await dialog.showMessageBox(win, {
    type: 'warning',
    title: '检查更新',
    message,
    buttons: ['好的'],
  });
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// "0.3.10" > "0.3.2" — 数值比较, 兼容多段
function isNewer(remote: string, local: string): boolean {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  const len = Math.max(r.length, l.length);
  for (let i = 0; i < len; i++) {
    const ri = r[i] ?? 0;
    const li = l[i] ?? 0;
    if (ri > li) return true;
    if (ri < li) return false;
  }
  return false;
}

function parseVersion(v: string): number[] {
  return v
    .split('.')
    .map((seg) => {
      const m = seg.match(/^\d+/);
      return m ? parseInt(m[0], 10) : 0;
    });
}
