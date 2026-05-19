import { ipcMain, app, dialog, shell, BrowserWindow } from 'electron';
import { copyFileSync, existsSync, statSync } from 'fs';
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

  // v0.6 D6: LLM 中转 + BYOK + 配额
  ipcMain.handle('llm:getActive', () => licenseManager.getActiveLlm());
  ipcMain.handle('llm:getQuota', () => licenseManager.fetchQuota());
  ipcMain.handle('llm:setDevMode', (_, enabled: boolean) => licenseManager.setDevMode(enabled));
  ipcMain.handle(
    'llm:setByok',
    (_, byok: { base_url: string; api_key: string; model: string }) =>
      licenseManager.setByok(byok),
  );

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

  // 日志导出 (内测期间用, 便于客服收集 bug 现场)
  ipcMain.handle('logs:getInfo', () => {
    const file = log.transports.file.getFile();
    const p = file.path;
    let size = 0;
    let exists = false;
    try {
      if (existsSync(p)) {
        size = statSync(p).size;
        exists = true;
      }
    } catch (e) {
      log.warn(`[ipc logs:getInfo] stat error: ${String(e)}`);
    }
    return { path: p, size, exists };
  });

  ipcMain.handle('logs:openFolder', () => {
    const p = log.transports.file.getFile().path;
    shell.showItemInFolder(p);
    return { ok: true, path: p };
  });

  // renderer → main 透传, 在 main.log 里盖一个 [renderer] 标记
  // 内测期间用, 让 LLM 调用 / tool_call 决策 / tool_result 都进 main.log, 便于离线分析
  ipcMain.handle('logs:write', (_, level: 'info' | 'warn' | 'error', scope: string, msg: string) => {
    const tag = `[renderer:${scope}]`;
    if (level === 'error') log.error(`${tag} ${msg}`);
    else if (level === 'warn') log.warn(`${tag} ${msg}`);
    else log.info(`${tag} ${msg}`);
    return { ok: true };
  });

  ipcMain.handle('logs:export', async (evt) => {
    const src = log.transports.file.getFile().path;
    if (!existsSync(src)) {
      return { ok: false, message: '日志文件不存在' };
    }
    const win = BrowserWindow.fromWebContents(evt.sender) ?? BrowserWindow.getFocusedWindow();
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const defaultName = `xhs-app-${app.getVersion()}-${ts}.log`;
    const r = await dialog.showSaveDialog(win!, {
      title: '导出日志文件',
      defaultPath: defaultName,
      filters: [{ name: '日志', extensions: ['log'] }],
    });
    if (r.canceled || !r.filePath) {
      return { ok: false, canceled: true };
    }
    try {
      copyFileSync(src, r.filePath);
      return { ok: true, savedTo: r.filePath };
    } catch (e) {
      log.error(`[ipc logs:export] copy error: ${String(e)}`);
      return { ok: false, message: String(e) };
    }
  });
}
