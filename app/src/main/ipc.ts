import { ipcMain, app } from 'electron';
import log from 'electron-log/main';
import type { GoSubprocess } from './go-subprocess';
import {
  listConversations, createConversation, getConversation, getMessages,
  saveMessages, setConversationTitle, deleteConversation, clearConversationMessages,
  type StoredMessage,
} from './conv';
import { checkRate, logRate, type RateAction } from './rate';
import { licenseManager } from './license';
import { checkForUpdatesNow } from './updater';
import {
  pickAndImport, importFromUrl, listAssets, deleteAsset, getAssetPath, touchUsed,
  setAssetTags, searchAssets,
} from './assets';
import { searchWeb } from './web-search';

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
  ipcMain.handle('conv:clearMessages', (_, id: string) => {
    clearConversationMessages(id);
    return { ok: true };
  });

  // 频率护栏
  ipcMain.handle('rate:check', (_, action: RateAction) => checkRate(action));
  ipcMain.handle('rate:log', (_, action: RateAction) => {
    logRate(action);
    return { ok: true };
  });

  // License
  ipcMain.handle('license:status', () => licenseManager.getStatus());
  ipcMain.handle('license:machineId', () => licenseManager.getMachineIdPublic());
  ipcMain.handle('license:activate', (_, code: string) => licenseManager.activate(code));
  ipcMain.handle('license:heartbeat', () => licenseManager.heartbeat());
  ipcMain.handle('license:clear', () => {
    licenseManager.clear();
    log.info('[ipc] license cleared by renderer');
    return { ok: true };
  });

  // Auto-update
  ipcMain.handle('updater:check', () => checkForUpdatesNow());

  // 媒体素材库
  ipcMain.handle('assets:pick', () => pickAndImport());
  ipcMain.handle('assets:importUrl', (_, url: string) => importFromUrl(url));
  ipcMain.handle('assets:list', () => listAssets());
  ipcMain.handle('assets:delete', (_, id: string) => deleteAsset(id));
  ipcMain.handle('assets:getPath', (_, id: string) => getAssetPath(id));
  ipcMain.handle('assets:touchUsed', (_, ids: string[]) => {
    touchUsed(ids);
    return { ok: true };
  });
  ipcMain.handle('assets:setTags', (_, id: string, tags: string[], description: string) => {
    setAssetTags(id, tags, description);
    return { ok: true };
  });
  ipcMain.handle('assets:search', (_, query: string, limit?: number) => searchAssets(query, limit));

  // 联网搜索 (隐藏 BrowserWindow + 搜狗 DOM 抓取)
  ipcMain.handle('web:search', (_, query: string, n?: number) => searchWeb(query, n));
}
