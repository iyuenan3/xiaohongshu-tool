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
import { checkForUpdatesNow, fetchVersionInfo } from './updater';
import {
  pickAndImport, importFromUrl, listAssets, deleteAsset, getAssetPath, touchUsed,
  setAssetTags, searchAssets,
} from './assets';
import { searchWeb } from './web-search';
import type { WorkflowScheduler } from './workflow-scheduler';
import {
  listWorkflows, getWorkflow, createWorkflow, updateWorkflow, softDeleteWorkflow,
  listRuns, getConfig, setConfig, type CreateWorkflowInput,
} from './workflow-db';
import { listTemplateMetas } from './workflow-templates';
import {
  getActiveProfile, createProfile, updateProfile, getProfile, listProfiles, setProfileStatus,
  type SaveProfileInput, type ProfileStatus,
} from './operating-db';

interface BrowserActions {
  openXhsWindow: () => void;
  toggleXhsWindow: () => void;
  hideXhsWindow: () => void;
  isXhsVisible: () => boolean;
  getXhsContext: () => Promise<{ url: string; title: string; text: string } | null>;
}

export function registerIpcHandlers(
  goProc: GoSubprocess,
  scheduler: WorkflowScheduler,
  actions: BrowserActions,
): void {
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
  ipcMain.handle('xhs:toggle', () => {
    actions.toggleXhsWindow();
    return { ok: true };
  });
  ipcMain.handle('xhs:hide', () => {
    actions.hideXhsWindow();
    return { ok: true };
  });
  ipcMain.handle('xhs:isVisible', () => actions.isXhsVisible());
  ipcMain.handle('page:getContext', async () => actions.getXhsContext());

  // 自主运营: 运营画像 (M1)
  ipcMain.handle('operating:get-active-profile', () => getActiveProfile());
  ipcMain.handle('operating:list-profiles', () => listProfiles());
  ipcMain.handle('operating:get-profile', (_e, id: number) => getProfile(id));
  ipcMain.handle('operating:save-profile', (_e, input: SaveProfileInput & { id?: number }) => {
    if (input.id) {
      updateProfile(input.id, input);
      return getProfile(input.id);
    }
    return createProfile(input);
  });
  ipcMain.handle('operating:set-profile-status', (_e, id: number, status: ProfileStatus) => {
    setProfileStatus(id, status);
    return { ok: true };
  });

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

  // v0.7 M7: 工作流
  ipcMain.handle('workflow:list', () => listWorkflows(false));
  ipcMain.handle('workflow:get', (_, id: number) => getWorkflow(id));
  ipcMain.handle('workflow:create', (_, input: CreateWorkflowInput) => {
    // 防御性 guard: race condition (templates 还没 fetch 完用户就点保存) 或 IPC 错位 都可能
    // 让 template_id / name 是 undefined/空 进来. 显式抛友好错误, 不让进 SQLite NOT NULL fail.
    if (!input?.template_id || typeof input.template_id !== 'string' || input.template_id.trim() === '') {
      throw new Error('workflow:create requires template_id (string)');
    }
    if (!input?.name || typeof input.name !== 'string' || input.name.trim() === '') {
      throw new Error('workflow:create requires name (string)');
    }
    const wf = createWorkflow(input);
    if (wf.enabled) scheduler.rescheduleOne(wf.id);
    return wf;
  });
  ipcMain.handle('workflow:update', (_, id: number, patch: Partial<{ name: string; params: unknown; schedule: unknown; enabled: number }>) => {
    const dbPatch: Record<string, unknown> = {};
    if (patch.name !== undefined) dbPatch.name = patch.name;
    if (patch.params !== undefined) dbPatch.params = JSON.stringify(patch.params);
    if (patch.schedule !== undefined) dbPatch.schedule = JSON.stringify(patch.schedule);
    if (patch.enabled !== undefined) dbPatch.enabled = patch.enabled;
    updateWorkflow(id, dbPatch);
    // 改 schedule / enable 都要重 schedule
    if (patch.schedule !== undefined || patch.enabled === 1) scheduler.rescheduleOne(id);
    if (patch.enabled === 0) scheduler.cancelOne(id);
    return { ok: true };
  });
  ipcMain.handle('workflow:enable', (_, id: number, on: boolean) => {
    updateWorkflow(id, { enabled: on ? 1 : 0, fail_count: on ? 0 : undefined });
    if (on) scheduler.rescheduleOne(id);
    else scheduler.cancelOne(id);
    return { ok: true };
  });
  ipcMain.handle('workflow:delete', (_, id: number) => {
    scheduler.cancelOne(id);
    softDeleteWorkflow(id);
    return { ok: true };
  });
  ipcMain.handle('workflow:run-now', async (_, id: number) => {
    return scheduler.runNow(id);
  });
  ipcMain.handle('workflow:runs', (_, id: number, limit?: number) => listRuns(id, limit ?? 50));
  ipcMain.handle('workflow:get-templates', () => listTemplateMetas());
  ipcMain.handle('workflow:dev-fire-soon', (_, id: number) => {
    scheduler.devFireSoon(id);
    return { ok: true };
  });
  ipcMain.handle('workflow:get-config', (_, key: string) => getConfig(key));
  ipcMain.handle('workflow:set-config', (_, key: string, value: string) => {
    setConfig(key, value);
    return { ok: true };
  });

  // Auto-update
  ipcMain.handle('updater:check', () => checkForUpdatesNow());
  ipcMain.handle('updater:versionInfo', () => fetchVersionInfo());

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
