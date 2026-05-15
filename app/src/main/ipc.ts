import { ipcMain, app } from 'electron';
import log from 'electron-log/main';
import type { GoSubprocess } from './go-subprocess';
import {
  listConversations, createConversation, getConversation, getMessages,
  saveMessages, setConversationTitle, deleteConversation,
  type StoredMessage,
} from './conv';
import { checkRate, logRate, type RateAction } from './rate';

interface BrowserActions {
  openXhsWindow: () => void;
  getXhsContext: () => Promise<{ url: string; title: string; text: string } | null>;
}

export function registerIpcHandlers(goProc: GoSubprocess, actions: BrowserActions): void {
  ipcMain.handle('app:ping', () => {
    log.info('[ipc] app:ping called');
    return `pong (electron ${process.versions.electron}, ${new Date().toISOString()})`;
  });

  ipcMain.handle('app:version', () => app.getVersion());

  // Go status / API 透传
  ipcMain.handle('go:status', async () => {
    try {
      const ok = await goProc.health();
      return { ok, baseUrl: ok ? goProc.baseUrl() : null };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  ipcMain.handle('go:api', async (_evt, method: string, path: string, body?: unknown) => {
    return goProc.callApi(method, path, body);
  });

  // 浏览器窗口
  ipcMain.handle('browser:openXhs', () => {
    actions.openXhsWindow();
    return { ok: true };
  });
  ipcMain.handle('page:getContext', async () => actions.getXhsContext());

  // 对话历史 (SQLite)
  ipcMain.handle('conv:list', () => listConversations());
  ipcMain.handle('conv:get', (_, id: string) => ({
    meta: getConversation(id),
    messages: getMessages(id),
  }));
  ipcMain.handle('conv:create', () => createConversation());
  ipcMain.handle('conv:saveMessages', (_, id: string, messages: StoredMessage[]) => {
    saveMessages(id, messages);
    return { ok: true };
  });
  ipcMain.handle('conv:setTitle', (_, id: string, title: string) => {
    setConversationTitle(id, title);
    return { ok: true };
  });
  ipcMain.handle('conv:delete', (_, id: string) => {
    deleteConversation(id);
    return { ok: true };
  });

  // 频率护栏
  ipcMain.handle('rate:check', (_, action: RateAction) => checkRate(action));
  ipcMain.handle('rate:log', (_, action: RateAction) => {
    logRate(action);
    return { ok: true };
  });
}
