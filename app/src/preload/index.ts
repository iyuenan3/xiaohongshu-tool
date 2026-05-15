import { contextBridge, ipcRenderer } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';

interface StoredMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
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
