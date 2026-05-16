import { app, BrowserWindow, protocol, screen, shell, net } from 'electron';
import { join, extname } from 'path';
import { pathToFileURL } from 'url';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import log from 'electron-log/main';
import { registerIpcHandlers } from './ipc';
import { GoSubprocess, resolveGoBinaryPath } from './go-subprocess';
import { pickFreePort, getElectronCdpWsUrl } from './cdp';
import { initDb, closeDb } from './db';
import { licenseManager } from './license';
import { initUpdater, stopUpdater } from './updater';
import { getAssetPath } from './assets';

// 在 app.whenReady() 之前注册自定义 scheme, 让 renderer 用 xhs-asset://{id} 加载本地素材
protocol.registerSchemesAsPrivileged([
  { scheme: 'xhs-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

log.initialize();
log.info('[main] app starting');

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
const goProc = new GoSubprocess();
let cdpPort: number | null = null;
let goStarted = false;

function createWindow(): void {
  const { workArea } = screen.getPrimaryDisplay();
  log.info(`[main] workArea=${workArea.width}x${workArea.height}`);

  // Chromium 在某些 macOS retina fractional scaling (如 14" "Looks Like 1800") 下
  // inner viewport 锁死 1280x800。锁定 BrowserWindow 1280x800 + 禁用 resize,
  // 让 outer = inner = 1280x800, 消除留白。最低屏幕要求 1440x900。
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: '小红书自运营系统',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      webSecurity: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    mainWindow.show();
    const cb = mainWindow.getContentBounds();
    mainWindow.setContentSize(cb.width, cb.height);
    if (is.dev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });




  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (!is.dev) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const k = input.key.toLowerCase();
      const blockedKey =
        k === 'f12' ||
        (input.meta && input.alt && k === 'i') ||
        (input.control && input.shift && k === 'i') ||
        (input.meta && input.alt && k === 'j') ||
        (input.control && input.shift && k === 'j');
      if (blockedKey) event.preventDefault();
    });
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow?.webContents.closeDevTools();
    });
  }

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

async function bootstrap(): Promise<void> {
  cdpPort = await pickFreePort();
  log.info(`[main] picked remote-debugging-port=${cdpPort}`);
  app.commandLine.appendSwitch('remote-debugging-port', String(cdpPort));
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');


  // 禁用 Chromium 对最小化/被遮挡 (含 left:-99999 隐藏的 webview) 的 page 节流,
  // 否则 tab 切换时 webview guest page 的 execution context 被销毁, Go CDP 调用返回 -32000
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,BackForwardCache');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

  await app.whenReady();
  electronApp.setAppUserModelId('com.xhs.app');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  initDb();

  // xhs-asset://{id} 把 renderer 请求 → DB 查 storage_path → 返回文件流
  protocol.handle('xhs-asset', async (req) => {
    try {
      const u = new URL(req.url);
      const id = u.hostname || u.pathname.replace(/^\/+/, '');
      const path = getAssetPath(id);
      if (!path) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(path).toString());
    } catch (e) {
      log.error('[protocol xhs-asset]', e);
      return new Response('error', { status: 500 });
    }
  });

  registerIpcHandlers(goProc, {
    openXhsWindow: () => {
      // <webview> 改造后, xhs 由 renderer 控制. main 进程仅 noop 占位
      // renderer 可直接调 webview.reload() (在 ChatSidebar 或 App 内实现)
      log.info('[ipc] openXhsWindow called (no-op in webview mode)');
    },
    getXhsContext: async () => {
      // <webview> 的上下文由 renderer 自己通过 webview.executeJavaScript 获取
      // 此 handler 保留兼容但返回 null, 真正的 context 走 renderer 路径
      return null;
    },
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  licenseManager.onActivated(() => {
    log.info('[main] license activated event - starting Go subprocess');
    licenseManager.startHeartbeatScheduler();
    ensureGoStarted().catch((err) => {
      log.error(`[main] post-activation Go start failed: ${err.message}`);
    });
  });

  const lic = await licenseManager.getStatus();
  log.info(`[main] license status: ${lic.status}`);
  if (lic.status === 'active') {
    licenseManager.startHeartbeatScheduler();
    ensureGoStarted().catch((err) => {
      log.error(`[main] Go bootstrap failed: ${err.message}`);
    });
  } else {
    log.info(`[main] license not active (${lic.status}); UI 将显示激活页, Go + xhs view 暂不启动`);
  }

  initUpdater(() => mainWindow);
}

async function ensureGoStarted(): Promise<void> {
  if (goStarted) {
    log.info('[main] ensureGoStarted: already started, noop');
    return;
  }
  goStarted = true;
  try {
    await spawnAndAttachGo();
  } catch (e) {
    goStarted = false;
    throw e;
  }
}

async function spawnAndAttachGo(): Promise<void> {
  const binPath = resolveGoBinaryPath();
  const userDataDir = app.getPath('userData');
  log.info(`[main] go binary: ${binPath}`);
  log.info(`[main] userData:  ${userDataDir}`);

  // <webview> 由 renderer 渲染 (App.tsx layout__xhs-slot 内), 跟 React UI 一起 ready
  // CDP attach 时 webview guest page 已经在 active targets, 不需要 main 进程预先创建

  const { baseUrl } = await goProc.start({ binPath, userDataDir });
  log.info(`[main] Go ready at ${baseUrl}`);

  if (cdpPort === null) throw new Error('cdpPort not set (bootstrap race)');
  const wsUrl = await getElectronCdpWsUrl(cdpPort);
  await goProc.attachCDP(wsUrl);

  log.info('[main] CDP attach 完成, Go 已接入 Electron Chromium');
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (isQuitting) return;
  log.info('[main] before-quit, stopping Go subprocess...');
  event.preventDefault();
  isQuitting = true;
  try { licenseManager.stopHeartbeatScheduler(); } catch (e) { log.warn(`[main] license stop error: ${String(e)}`); }
  try { stopUpdater(); } catch (e) { log.warn(`[main] updater stop error: ${String(e)}`); }
  try {
    await goProc.stop();
  } catch (e) {
    log.warn(`[main] Go stop error: ${String(e)}`);
  }
  try {
    closeDb();
  } catch (e) {
    log.warn(`[main] db close error: ${String(e)}`);
  }
  log.info('[main] cleanup done, exiting');
  app.exit(0);
});

bootstrap().catch((err) => {
  log.error(`[main] bootstrap fatal: ${err.message}`);
  app.exit(1);
});
