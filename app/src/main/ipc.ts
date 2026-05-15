import { ipcMain, app } from 'electron';
import log from 'electron-log/main';
import type { GoSubprocess } from './go-subprocess';

interface BrowserActions {
  openXhsWindow: () => void;
}

export function registerIpcHandlers(goProc: GoSubprocess, browserActions: BrowserActions): void {
  ipcMain.handle('app:ping', () => {
    log.info('[ipc] app:ping called');
    return `pong (electron ${process.versions.electron}, ${new Date().toISOString()})`;
  });

  ipcMain.handle('app:version', () => app.getVersion());

  // M1 D5-D7 联调用: 暴露 Go 子进程状态
  ipcMain.handle('go:status', async () => {
    try {
      const ok = await goProc.health();
      return { ok, baseUrl: ok ? goProc.baseUrl() : null };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  // 通用 MCP/HTTP 透传: renderer 可调用 Go 端 API
  ipcMain.handle('go:api', async (_evt, method: string, path: string, body?: unknown) => {
    return goProc.callApi(method, path, body);
  });

  // 重开/聚焦小红书浏览器窗口 (用户不小心关掉时)
  ipcMain.handle('browser:openXhs', () => {
    browserActions.openXhsWindow();
    return { ok: true };
  });
}
