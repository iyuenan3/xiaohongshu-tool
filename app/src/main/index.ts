import { app, BrowserWindow, shell } from 'electron';
import { join } from 'path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import log from 'electron-log/main';
import { registerIpcHandlers } from './ipc';
import { GoSubprocess, resolveGoBinaryPath } from './go-subprocess';
import { pickFreePort, getElectronCdpWsUrl } from './cdp';
import { initDb, closeDb } from './db';
import { licenseManager } from './license';

log.initialize();
log.info('[main] app starting');

let mainWindow: BrowserWindow | null = null;
let xhsWindow: BrowserWindow | null = null;
let isQuitting = false; // before-quit 时设 true, 让 xhs 窗口真正关闭
const goProc = new GoSubprocess();
let cdpPort: number | null = null;
let goStarted = false; // ensureGoStarted 幂等保护

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: '小红书自运营系统',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // M2 dev: 允许 renderer 直接 fetch LLM API (cross-origin)
      // M3 商业化阶段会把 LLM 调用收回主进程 (safeStorage + IPC), 届时关闭
      webSecurity: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  // Prod 模式: 拦截 DevTools 打开 + 屏蔽相关快捷键 (asar 加固一部分)
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

/**
 * 创建独立的小红书浏览器窗口供 Go 端通过 CDP 操作。
 *
 * 关闭行为: 用户点 ✕ 时窗口仅隐藏 (cookies + page 保留),
 * 应用 quit 时才真正销毁。这避免用户不小心关窗口导致 Go 找不到 page。
 */
function createXhsBrowserWindow(): void {
  if (xhsWindow && !xhsWindow.isDestroyed()) {
    if (xhsWindow.isMinimized()) xhsWindow.restore();
    if (!xhsWindow.isVisible()) xhsWindow.show();
    xhsWindow.focus();
    return;
  }
  xhsWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: '小红书 (受 Go MCP 控制)',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 最小化时不节流, 防止 CDP execution context 被销毁
    },
  });
  xhsWindow.loadURL('https://www.xiaohongshu.com/explore');

  // 拦截关闭: 改为 minimize (hide 会让 Chromium 从 active targets 移除 page,
  // 导致 Go 端 CDP 看不到, 必须保持窗口"存在"但可缩到 dock)。
  xhsWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      xhsWindow?.minimize();
      log.info('[xhs-window] 用户关闭, 已改为最小化 (Chromium page 仍在 active targets)');
    }
  });
  xhsWindow.on('closed', () => { xhsWindow = null; });
}

/**
 * bootstrap 在 app.ready 之前选择空闲端口, 注入 --remote-debugging-port,
 * 之后启动 Electron, 再编排 Go subprocess 启动 + CDP attach。
 */
async function bootstrap(): Promise<void> {
  // 1. 选择空闲端口供 Chromium DevTools 监听
  cdpPort = await pickFreePort();
  log.info(`[main] picked remote-debugging-port=${cdpPort}`);
  app.commandLine.appendSwitch('remote-debugging-port', String(cdpPort));
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');

  // 禁用 Chromium 对最小化/被遮挡窗口的 page 节流, 防止 Go 端 CDP 操作时
  // 触发 "Execution context was destroyed" 错误.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,BackForwardCache');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

  // 2. 等 Electron ready
  await app.whenReady();
  electronApp.setAppUserModelId('com.xhs.app');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // 初始化 SQLite (conv 历史 + rate_log)
  initDb();

  registerIpcHandlers(goProc, {
    openXhsWindow: createXhsBrowserWindow,
    getXhsContext: async () => {
      if (!xhsWindow || xhsWindow.isDestroyed()) return null;
      const wc = xhsWindow.webContents;
      try {
        const url = wc.getURL();
        const title = wc.getTitle();
        const text = await wc.executeJavaScript(
          'document.body && document.body.innerText ? document.body.innerText.slice(0, 4000) : ""',
        ) as string;
        return { url, title, text };
      } catch {
        return null;
      }
    },
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // 3. License gate: 仅在已激活时才启动 Go subprocess
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
    log.info(`[main] license not active (${lic.status}); UI 将显示激活页, Go 暂不启动`);
  }
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

  const { baseUrl } = await goProc.start({ binPath, userDataDir });
  log.info(`[main] Go ready at ${baseUrl}`);

  if (cdpPort === null) {
    throw new Error('cdpPort not set (bootstrap race)');
  }
  const wsUrl = await getElectronCdpWsUrl(cdpPort);
  await goProc.attachCDP(wsUrl);

  log.info('[main] CDP attach 完成, Go 已接入 Electron Chromium');

  // 打开小红书浏览器窗口供 Go 操作 (UI 窗口保持不变)
  createXhsBrowserWindow();
  log.info('[main] xhs 浏览器窗口已打开');
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (isQuitting) return; // 防止递归
  log.info('[main] before-quit, stopping Go subprocess...');
  event.preventDefault();
  isQuitting = true;
  try { licenseManager.stopHeartbeatScheduler(); } catch (e) { log.warn(`[main] license stop error: ${String(e)}`); }
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
