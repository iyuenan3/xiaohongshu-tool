import { app, BrowserWindow, protocol, screen, shell, net, session } from 'electron';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import log from 'electron-log/main';
import { registerIpcHandlers } from './ipc';
import { WorkflowScheduler } from './workflow-scheduler';
import { GoSubprocess, resolveGoBinaryPath } from './go-subprocess';
import { pickFreePort, getElectronCdpWsUrl } from './cdp';
import { initDb, closeDb } from './db';
import { licenseManager } from './license';
import { initUpdater, stopUpdater } from './updater';
import { getAssetPath } from './assets';
import { logEnvironment } from './env';
import { createXhsWindow, toggleXhsWindow, hideXhsWindow, isXhsVisible, destroyXhsWindow, onVisibilityChanged } from './xhs-window';

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

  // 主控制台窗口: chromium retina fractional scaling bug 锁 inner viewport 1280×800. 接受方案: 锁定 outer 1280×800 + 禁 resize, 消除留白.
  // 小红书页面用独立 BrowserWindow (helper popup 路径) 绕开锁, 见 xhs-window.ts.
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
      webSecurity: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    mainWindow.show();
    if (is.dev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('closed', () => {
    log.info('[main] main window closed, quitting app');
    app.quit();
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


  // 禁用 Chromium 对最小化/被遮挡的 page 节流,
  // 独立 xhs 窗口 hide 时 occlusion 节流让 Go CDP 调用返回 -32000 (execution context 被销毁)
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,BackForwardCache');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

  await app.whenReady();
  electronApp.setAppUserModelId('com.xhs.app');

  // v0.8: 主进程 net.fetch (license/version → bj 自签) 不走下方 certificate-error 事件,
  // 需 session 级 setCertificateVerifyProc 放行 newapi 中转 IP 的自签证书。
  session.defaultSession.setCertificateVerifyProc((req, callback) => {
    callback(req.hostname === '39.96.12.136' ? 0 : -3);   // 0=信任该自签 / -3=其余沿用 Chromium 默认校验
  });

  // v0.6 D6: cert-error 动态放行 newapi 中转 IP (Caddy 自签 sni-fallback)
  // allowedHosts 从 license.llm.base_url 动态解析, 兜底硬编码 IP
  app.on('certificate-error', (event, _webContents, url, _error, _cert, callback) => {
    const allowed = new Set<string>(['39.96.12.136']);
    // 同步读 license cache (loadStored 已在 cacheLoaded 时初始化)
    try {
      // void Promise: 不 await, 同步用 cached llm config 即可 (cacheLoaded 在 getStatus 时已 load)
      void licenseManager.getActiveLlm().then((llm) => {
        if (llm?.base_url) {
          try { allowed.add(new URL(llm.base_url).hostname); } catch { /* ignore */ }
        }
      });
    } catch { /* ignore, fall back to default */ }

    try {
      const host = new URL(url).hostname;
      if (allowed.has(host)) {
        event.preventDefault();
        callback(true);    // trust this self-signed cert (newapi 中转 IP)
        log.info(`[cert] trust self-signed for ${host}`);
        return;
      }
    } catch { /* fall through */ }

    callback(false);    // reject all other invalid certs (preserve security)
    log.warn(`[cert] reject invalid cert for ${url}`);
  });

  // 启动 banner: app/OS/electron/chromium/cpu/memory/displays/locale/timezone/license 一次性 dump
  // 便于客服收到日志后立即识别用户环境, 不用再追问"你 win 还是 mac"
  await logEnvironment();

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

  const workflowScheduler = new WorkflowScheduler(goProc);
  registerIpcHandlers(goProc, workflowScheduler, {
    openXhsWindow: () => {
      void createXhsWindow();
    },
    toggleXhsWindow: () => {
      toggleXhsWindow();
    },
    hideXhsWindow: () => {
      hideXhsWindow();
    },
    isXhsVisible: () => isXhsVisible(),
    getXhsContext: async () => {
      // 独立窗口模式: chat 通过 Go MCP (page:list_feeds 等) 拿上下文, 不走 webview.executeJavaScript 路径
      return null;
    },
  });
  createWindow();
  if (mainWindow) workflowScheduler.setMainWindow(mainWindow);

  // 独立 xhs 窗口可见性变化 → push 主窗 renderer, 让按钮文案/icon 同步
  onVisibilityChanged((visible) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('xhs:visibility-changed', visible);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  licenseManager.onActivated(() => {
    log.info('[main] license activated event - starting Go subprocess + xhs window');
    licenseManager.startHeartbeatScheduler();
    void createXhsWindow();
    ensureGoStarted()
      .then(() => workflowScheduler.init())
      .catch((err) => {
        log.error(`[main] post-activation Go start failed: ${err.message}`);
      });
  });

  // license 任何状态变化 (activate / heartbeat-revoked / clear) push 给 renderer
  // 让 React 端 App.tsx 可以实时 setLicenseState, 不再依赖 ActivationPage onActivated 回调
  licenseManager.onChanged((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('license:changed', state);
    }
  });

  const lic = await licenseManager.getStatus();
  log.info(`[main] license status: ${lic.status}`);
  if (lic.status === 'active') {
    licenseManager.startHeartbeatScheduler();
    void createXhsWindow();
    ensureGoStarted()
      .then(() => workflowScheduler.init())
      .catch((err) => {
        log.error(`[main] Go bootstrap failed: ${err.message}`);
      });
  } else {
    log.info(`[main] license not active (${lic.status}); UI 将显示激活页, Go + xhs window 暂不启动`);
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
  log.info('[main] before-quit, stopping Go subprocess + xhs window...');
  event.preventDefault();
  isQuitting = true;
  try { destroyXhsWindow(); } catch (e) { log.warn(`[main] xhs window destroy error: ${String(e)}`); }
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
