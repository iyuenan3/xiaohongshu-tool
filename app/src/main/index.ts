import { app, BrowserWindow, shell } from 'electron';
import { join } from 'path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import log from 'electron-log/main';
import { registerIpcHandlers } from './ipc';
import { GoSubprocess, resolveGoBinaryPath } from './go-subprocess';
import { pickFreePort, getElectronCdpWsUrl } from './cdp';

log.initialize();
log.info('[main] app starting');

let mainWindow: BrowserWindow | null = null;
let xhsWindow: BrowserWindow | null = null;
const goProc = new GoSubprocess();
let cdpPort: number | null = null;

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
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/** 创建独立的小红书浏览器窗口供 Go 端通过 CDP 操作。 */
function createXhsBrowserWindow(): void {
  if (xhsWindow && !xhsWindow.isDestroyed()) {
    xhsWindow.focus();
    return;
  }
  xhsWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: '小红书 (受 Go MCP 控制)',
    autoHideMenuBar: true,
    webPreferences: {
      // 不挂 preload, 让小红书页面认为是普通 Chromium
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  xhsWindow.loadURL('https://www.xiaohongshu.com/explore');
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

  // 2. 等 Electron ready
  await app.whenReady();
  electronApp.setAppUserModelId('com.xhs.app');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  registerIpcHandlers(goProc);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // 3. spawn Go subprocess (异步, 不阻塞 UI 显示)
  spawnAndAttachGo().catch((err) => {
    log.error(`[main] Go bootstrap failed: ${err.message}`);
    // M1 PoC 阶段允许 UI 先起来, Go 失败用户能看到错误状态
  });
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
  log.info('[main] before-quit, stopping Go subprocess...');
  event.preventDefault();
  try {
    await goProc.stop();
  } catch (e) {
    log.warn(`[main] Go stop error: ${String(e)}`);
  }
  log.info('[main] cleanup done, exiting');
  app.exit(0);
});

bootstrap().catch((err) => {
  log.error(`[main] bootstrap fatal: ${err.message}`);
  app.exit(1);
});
