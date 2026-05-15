import { contextBridge, ipcRenderer } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';

const api = {
  ping: () => ipcRenderer.invoke('app:ping'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  // Go subprocess 状态 + 透传 API
  goStatus: () =>
    ipcRenderer.invoke('go:status') as Promise<{
      ok: boolean;
      baseUrl?: string | null;
      error?: string;
    }>,
  goApi: (method: string, path: string, body?: unknown) =>
    ipcRenderer.invoke('go:api', method, path, body),
  openXhsWindow: () => ipcRenderer.invoke('browser:openXhs') as Promise<{ ok: boolean }>,
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
