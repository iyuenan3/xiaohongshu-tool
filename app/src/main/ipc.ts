import { ipcMain, app } from 'electron';
import log from 'electron-log/main';

export function registerIpcHandlers(): void {
  ipcMain.handle('app:ping', () => {
    log.info('[ipc] app:ping called');
    return `pong (electron ${process.versions.electron}, ${new Date().toISOString()})`;
  });

  ipcMain.handle('app:version', () => app.getVersion());
}
