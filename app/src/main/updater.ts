import { app, dialog, BrowserWindow } from 'electron';
import pkg from 'electron-updater';
import log from 'electron-log/main';

const { autoUpdater } = pkg;

autoUpdater.logger = log;
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const CHECK_DELAY_AFTER_START_MS = 8 * 1000;

let mainWindowRef: BrowserWindow | null = null;
let intervalTimer: NodeJS.Timeout | null = null;

export function initUpdater(getMainWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) {
    log.info('[updater] dev mode, skipping auto-update');
    return;
  }
  mainWindowRef = getMainWindow();

  autoUpdater.on('checking-for-update', () => {
    log.info('[updater] checking for updates...');
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info(`[updater] up-to-date (current: ${app.getVersion()}, server: ${info.version})`);
  });

  autoUpdater.on('update-available', async (info) => {
    log.info(`[updater] update available: ${info.version}`);
    const win = mainWindowRef ?? getMainWindow();
    if (!win) return;
    const res = await dialog.showMessageBox(win, {
      type: 'info',
      title: '有新版本',
      message: `小红书自运营 ${info.version} 已发布`,
      detail: `当前版本 ${app.getVersion()}。是否现在下载？\n\n更新会在后台进行，不影响当前使用。下载完成后会询问是否重启。`,
      buttons: ['立即下载', '稍后提醒'],
      defaultId: 0,
      cancelId: 1,
    });
    if (res.response === 0) {
      try { await autoUpdater.downloadUpdate(); } catch (e) {
        log.error(`[updater] downloadUpdate error: ${e}`);
      }
    }
  });

  autoUpdater.on('download-progress', (p) => {
    log.info(`[updater] downloading ${p.percent.toFixed(1)}% (${(p.bytesPerSecond / 1024).toFixed(0)} KB/s)`);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    log.info(`[updater] update downloaded: ${info.version}`);
    const win = mainWindowRef ?? getMainWindow();
    if (!win) return;
    const res = await dialog.showMessageBox(win, {
      type: 'info',
      title: '更新已就绪',
      message: `小红书自运营 ${info.version} 下载完成`,
      detail: '重启应用即可使用新版本。也可以稍后重启（应用退出时会自动安装）。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    });
    if (res.response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (err) => {
    log.warn(`[updater] error: ${err?.message ?? String(err)}`);
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => log.warn(`[updater] initial check: ${e}`));
  }, CHECK_DELAY_AFTER_START_MS);

  intervalTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch((e) => log.warn(`[updater] periodic check: ${e}`));
  }, CHECK_INTERVAL_MS);
}

export function stopUpdater(): void {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}

export async function checkForUpdatesNow(): Promise<{ ok: boolean; version?: string; message?: string }> {
  if (!app.isPackaged) {
    return { ok: false, message: 'dev mode, updater disabled' };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result) return { ok: true, message: 'no update info' };
    return { ok: true, version: result.updateInfo.version };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}
