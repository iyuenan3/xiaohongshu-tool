import { contextBridge, ipcRenderer } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';

interface StoredMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
}

// v0.6 D6
interface LlmConfigP {
  base_url: string;
  api_key: string;
  model: string;
}

interface LicenseStateP {
  status: 'unactivated' | 'active' | 'suspended' | 'expired' | 'revoked' | 'mismatch' | 'error';
  code?: string;
  machine_id?: string;
  valid_until?: number;
  message?: string;
  llm?: LlmConfigP | null;
  byok?: LlmConfigP;
  dev_mode?: boolean;
  suspend_reason?: string | null;
}

// v0.7 M7 工作流
export interface ScheduleP {
  type: 'daily' | 'weekly' | 'interval' | 'manual';
  hour?: number;
  minute?: number;
  weekday?: number;
  interval_hours?: number;
  jitter_min?: number;
  tz: string;
}

export interface WorkflowP {
  id: number;
  template_id: string;
  name: string;
  params: string;
  schedule: string;
  enabled: number;
  deleted_at: number | null;
  fail_count: number;
  created_at: number;
  updated_at: number;
  last_fire_at: number | null;
  next_fire_at: number | null;
}

export interface WorkflowRunP {
  id: number;
  workflow_id: number;
  started_at: number;
  finished_at: number | null;
  status: 'running' | 'success' | 'partial' | 'failed' | 'missed' | 'aborted' | 'disabled_by_failure';
  fail_reason: string | null;
  summary: string | null;
  steps_log: string | null;
  error: string | null;
}

export interface TemplateMetaP {
  id: string;
  name: string;
  emoji: string;
  description: string;
  paramsSchema: Record<string, { type: 'int' | 'enum' | 'string' | 'image_list'; min?: number; max?: number; options?: string[]; default?: unknown; label: string }>;
}

function onPush<T>(channel: string, cb: (e: T) => void): () => void {
  const handler = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

interface MediaAsset {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  source_url: string | null;
  storage_path: string;
  width: number | null;
  height: number | null;
  created_at: number;
  last_used_at: number;
  tags: string;          // JSON array string
  description: string | null;
  analyzed: number;      // 0/1
}

const api = {
  ping: () => ipcRenderer.invoke('app:ping'),
  getVersion: () => ipcRenderer.invoke('app:version'),

  // Go 子进程
  goStatus: () => ipcRenderer.invoke('go:status') as Promise<{ ok: boolean; baseUrl?: string | null; error?: string }>,
  goApi: (method: string, path: string, body?: unknown) => ipcRenderer.invoke('go:api', method, path, body),

  // 浏览器窗口
  openXhsWindow: () => ipcRenderer.invoke('browser:openXhs') as Promise<{ ok: boolean }>,
  getPageContext: () =>
    ipcRenderer.invoke('page:getContext') as Promise<{ url: string; title: string; text: string } | null>,

  // 对话历史
  conv: {
    list: () => ipcRenderer.invoke('conv:list') as Promise<Array<{ id: string; title: string | null; created_at: number; updated_at: number }>>,
    get: (id: string) => ipcRenderer.invoke('conv:get', id) as Promise<{ meta: { id: string; title: string | null } | null; messages: StoredMsg[] }>,
    create: () => ipcRenderer.invoke('conv:create') as Promise<string>,
    saveMessages: (id: string, messages: StoredMsg[]) => ipcRenderer.invoke('conv:saveMessages', id, messages) as Promise<{ ok: boolean }>,
    setTitle: (id: string, title: string) => ipcRenderer.invoke('conv:setTitle', id, title) as Promise<{ ok: boolean }>,
    delete: (id: string) => ipcRenderer.invoke('conv:delete', id) as Promise<{ ok: boolean }>,
    clearMessages: (id: string) => ipcRenderer.invoke('conv:clearMessages', id) as Promise<{ ok: boolean }>,
  },

  // 频率护栏
  rate: {
    check: (action: 'publish' | 'comment' | 'like' | 'favorite') =>
      ipcRenderer.invoke('rate:check', action) as Promise<{
        allowed: boolean; reason?: string;
        windowCount?: number; windowMax?: number; nextAvailableAt?: number;
      }>,
    log: (action: 'publish' | 'comment' | 'like' | 'favorite') =>
      ipcRenderer.invoke('rate:log', action) as Promise<{ ok: boolean }>,
  },

  // Auto-update
  updater: {
    check: () => ipcRenderer.invoke('updater:check') as Promise<{ ok: boolean; version?: string; message?: string }>,
  },

  // License
  license: {
    status: () => ipcRenderer.invoke('license:status') as Promise<LicenseStateP>,
    getMachineId: () => ipcRenderer.invoke('license:machineId') as Promise<string>,
    activate: (code: string) => ipcRenderer.invoke('license:activate', code) as Promise<LicenseStateP>,
    heartbeat: () => ipcRenderer.invoke('license:heartbeat') as Promise<{
      ok: boolean;
      revoked?: boolean;
      status?: 'active' | 'suspended' | 'revoked';
      latest_version?: string;
      message?: string;
    }>,
    clear: () => ipcRenderer.invoke('license:clear') as Promise<{ ok: boolean }>,
    onChanged: (cb: (state: LicenseStateP) => void) => {
      const handler = (_e: unknown, state: LicenseStateP) => cb(state);
      ipcRenderer.on('license:changed', handler);
      return () => { ipcRenderer.removeListener('license:changed', handler); };
    },
  },

  // v0.6 D6: LLM 中转 + BYOK + 配额
  llm: {
    getActive: () => ipcRenderer.invoke('llm:getActive') as Promise<LlmConfigP | null>,
    getQuota: () => ipcRenderer.invoke('llm:getQuota') as Promise<{
      remain_cny: number;
      total_cny: number;
      used_cny: number;
      next_reset_at: number;
    } | null>,
    setDevMode: (enabled: boolean) => ipcRenderer.invoke('llm:setDevMode', enabled) as Promise<void>,
    setByok: (byok: LlmConfigP) => ipcRenderer.invoke('llm:setByok', byok) as Promise<void>,
  },

  // 媒体素材库
  assets: {
    pick: () => ipcRenderer.invoke('assets:pick') as Promise<MediaAsset[]>,
    importUrl: (url: string) => ipcRenderer.invoke('assets:importUrl', url) as Promise<MediaAsset>,
    list: () => ipcRenderer.invoke('assets:list') as Promise<MediaAsset[]>,
    delete: (id: string) => ipcRenderer.invoke('assets:delete', id) as Promise<void>,
    getPath: (id: string) => ipcRenderer.invoke('assets:getPath', id) as Promise<string | null>,
    touchUsed: (ids: string[]) => ipcRenderer.invoke('assets:touchUsed', ids) as Promise<{ ok: boolean }>,
    setTags: (id: string, tags: string[], description: string) =>
      ipcRenderer.invoke('assets:setTags', id, tags, description) as Promise<{ ok: boolean }>,
    search: (query: string, limit?: number) =>
      ipcRenderer.invoke('assets:search', query, limit) as Promise<MediaAsset[]>,
  },

  // 联网搜索 (搜狗 HTML)
  web: {
    search: (query: string, n?: number) =>
      ipcRenderer.invoke('web:search', query, n) as Promise<Array<{ title: string; url: string; snippet: string }>>,
  },

  // v0.7 M7: 工作流
  workflow: {
    list: () => ipcRenderer.invoke('workflow:list') as Promise<WorkflowP[]>,
    get: (id: number) => ipcRenderer.invoke('workflow:get', id) as Promise<WorkflowP | null>,
    create: (input: {
      template_id: string; name: string; params: Record<string, unknown>; schedule: ScheduleP; enabled?: boolean;
    }) => ipcRenderer.invoke('workflow:create', input) as Promise<WorkflowP>,
    update: (id: number, patch: { name?: string; params?: Record<string, unknown>; schedule?: ScheduleP; enabled?: number }) =>
      ipcRenderer.invoke('workflow:update', id, patch) as Promise<{ ok: boolean }>,
    enable: (id: number, on: boolean) => ipcRenderer.invoke('workflow:enable', id, on) as Promise<{ ok: boolean }>,
    delete: (id: number) => ipcRenderer.invoke('workflow:delete', id) as Promise<{ ok: boolean }>,
    runNow: (id: number) => ipcRenderer.invoke('workflow:run-now', id) as Promise<{ runId: number | null }>,
    runs: (id: number, limit?: number) => ipcRenderer.invoke('workflow:runs', id, limit) as Promise<WorkflowRunP[]>,
    getTemplates: () => ipcRenderer.invoke('workflow:get-templates') as Promise<TemplateMetaP[]>,
    devFireSoon: (id: number) => ipcRenderer.invoke('workflow:dev-fire-soon', id) as Promise<{ ok: boolean }>,
    getConfig: (key: string) => ipcRenderer.invoke('workflow:get-config', key) as Promise<string | null>,
    setConfig: (key: string, value: string) => ipcRenderer.invoke('workflow:set-config', key, value) as Promise<{ ok: boolean }>,
    onRunStarted: (cb: (e: { runId: number; workflowId: number }) => void) => onPush('workflow:run-started', cb),
    onRunStepUpdate: (cb: (e: { runId: number; step: { step: string; at: number; result?: unknown; error?: string } }) => void) =>
      onPush('workflow:run-step-update', cb),
    onRunFinished: (cb: (e: { runId: number; workflowId: number; status: string; failReason?: string }) => void) =>
      onPush('workflow:run-finished', cb),
    onAutoDisabled: (cb: (e: { workflowId: number; lastReason: string }) => void) =>
      onPush('workflow:auto-disabled', cb),
  },

  // 日志导出 + renderer 透传 (内测期间用)
  logs: {
    getInfo: () => ipcRenderer.invoke('logs:getInfo') as Promise<{ path: string; size: number; exists: boolean }>,
    openFolder: () => ipcRenderer.invoke('logs:openFolder') as Promise<{ ok: boolean; path: string }>,
    export: () => ipcRenderer.invoke('logs:export') as Promise<{ ok: boolean; canceled?: boolean; savedTo?: string; message?: string }>,
    write: (level: 'info' | 'warn' | 'error', scope: string, msg: string) =>
      ipcRenderer.invoke('logs:write', level, scope, msg) as Promise<{ ok: boolean }>,
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI);
    contextBridge.exposeInMainWorld('api', api);
  } catch (error) {
    console.error('[preload] contextBridge exposure failed:', error);
  }
} else {
  // @ts-ignore
  window.electron = electronAPI;
  // @ts-ignore
  window.api = api;
}

export type Api = typeof api;
