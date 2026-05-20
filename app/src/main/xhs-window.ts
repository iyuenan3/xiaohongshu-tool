import { BrowserWindow } from 'electron';
import log from 'electron-log/main';

// 独立小红书窗口: 通过 hidden helper window (partition='persist:xhs') 触发 native window.open,
// setWindowOpenHandler 返 'allow' 但不带 override → popup 走 chromium 默认路径,
// 不被 retina viewport lock 限制 (用户实测验证: 二级 popup 不锁, 一级 popup 带 override 仍锁).
// helper 共享 persist:xhs partition → popup 继承登录 cookies, 不丢登录态.

const XHS_URL = 'https://www.xiaohongshu.com/explore';
const XHS_TARGET = 'xhs-main';

let xhsWindow: BrowserWindow | null = null;
let helperWindow: BrowserWindow | null = null;
let helperReady: Promise<void> | null = null;
const listeners = new Set<(visible: boolean) => void>();

function emit(visible: boolean): void {
  for (const cb of listeners) {
    try { cb(visible); } catch (e) { log.warn(`[xhs-window] listener error: ${String(e)}`); }
  }
}

export function getXhsWindow(): BrowserWindow | null {
  return xhsWindow;
}

export function isXhsVisible(): boolean {
  return xhsWindow != null && !xhsWindow.isDestroyed() && xhsWindow.isVisible();
}

export function onVisibilityChanged(cb: (visible: boolean) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

async function ensureHelper(): Promise<BrowserWindow> {
  if (helperWindow && !helperWindow.isDestroyed()) {
    if (helperReady) await helperReady;
    return helperWindow;
  }

  // helper 必须 visible (实测 show:false 时 sendInputEvent click 不命中 → popup 创建失败).
  // opacity:0 + 极远 off-screen + 极小 size 让用户实质上看不见.
  helperWindow = new BrowserWindow({
    width: 100,
    height: 100,
    x: -99999,
    y: -99999,
    show: true,
    skipTaskbar: true,
    focusable: false,
    frame: false,
    opacity: 0,
    webPreferences: {
      partition: 'persist:xhs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 拦截 helper renderer 调 window.open: 仅放行 xiaohongshu.com, 其他拒. 关键: 不传 overrideBrowserWindowOptions
  // 让 popup 走 chromium 默认路径 (绕开 retina viewport lock)
  helperWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.includes('xiaohongshu.com')) {
      return { action: 'allow' };
    }
    return { action: 'deny' };
  });

  helperWindow.webContents.on('did-create-window', (window, details) => {
    if (details.url.includes('xiaohongshu.com')) {
      attachXhsWindow(window);
    }
  });

  // 关键: helper 加载 xhs.com 而非 about:blank, 让 opener 跟 popup 同 origin.
  // 实测: about:blank opener → cross-origin popup → chromium 应用 retina viewport lock;
  //       xhs.com opener → same-origin popup → 不锁 (跟用户实测二级 popup 等价)
  helperReady = helperWindow.loadURL('https://www.xiaohongshu.com/').then(() => {
    log.info('[xhs-window] helper ready (xhs.com, persist:xhs)');
  });
  await helperReady;
  return helperWindow;
}

function attachXhsWindow(win: BrowserWindow): void {
  if (xhsWindow && !xhsWindow.isDestroyed() && xhsWindow !== win) {
    log.warn('[xhs-window] attachXhsWindow: replacing existing window');
  }
  xhsWindow = win;

  win.on('close', (e) => {
    if (xhsWindow && !xhsWindow.isDestroyed()) {
      e.preventDefault();
      xhsWindow.hide();
    }
  });


  win.on('show', () => emit(true));
  win.on('hide', () => emit(false));
  win.on('closed', () => {
    if (xhsWindow === win) xhsWindow = null;
    emit(false);
  });

  log.info('[xhs-window] attached (helper-popup) partition=persist:xhs');
}

export async function createXhsWindow(): Promise<void> {
  if (xhsWindow && !xhsWindow.isDestroyed()) {
    showXhsWindow();
    return;
  }
  try {
    const helper = await ensureHelper();
    // 关键: 用 <a target=_blank> click 模拟 link navigation, 而非 window.open script call.
    // 实测二级 popup (用户点头像 link 弹出) inner 跟 outer 联动 (lock-free),
    // 而 window.open 触发的 popup inner 锁 1280×800. chromium 区分 navigation vs script popup.
    // 关键: 用 sendInputEvent 注入真实 mouse click, chromium 视为 user gesture, popup 走 lock-free 路径.
    // 实测 a.click() / window.open() (script-triggered) 都触发 viewport lock 1280×800;
    // 用户点 xhs.com 头像 link 弹的二级 popup (real mouse) lock-free.
    const code = `(function(){
      const a = document.createElement('a');
      a.href = ${JSON.stringify(XHS_URL)};
      a.target = ${JSON.stringify(XHS_TARGET)};
      a.id = '__xhs_helper_link';
      a.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; z-index:2147483647; opacity:0; display:block;';
      a.textContent = ' ';
      document.documentElement.appendChild(a);
      void document.body.offsetHeight; // force layout flush
      const r = a.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`;
    const rect = await helper.webContents.executeJavaScript(code, true) as { x: number; y: number; width: number; height: number };
    const cx = Math.max(1, Math.round(rect.x + 10));
    const cy = Math.max(1, Math.round(rect.y + 10));
    log.info(`[xhs-window] click target rect=${JSON.stringify(rect)} → (${cx},${cy})`);
    helper.focus();
    helper.webContents.focus();
    helper.webContents.sendInputEvent({ type: 'mouseMove', x: cx, y: cy });
    helper.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
    helper.webContents.sendInputEvent({ type: 'mouseUp',   x: cx, y: cy, button: 'left', clickCount: 1 });
    log.info('[xhs-window] window.open dispatched via helper');
  } catch (e) {
    log.error(`[xhs-window] createXhsWindow failed: ${String(e)}`);
  }
}

export function showXhsWindow(): void {
  if (!xhsWindow || xhsWindow.isDestroyed()) return;
  if (xhsWindow.isMinimized()) xhsWindow.restore();
  xhsWindow.show();
  xhsWindow.focus();
}

export function hideXhsWindow(): void {
  if (xhsWindow && !xhsWindow.isDestroyed() && xhsWindow.isVisible()) {
    xhsWindow.hide();
  }
}

export function toggleXhsWindow(): void {
  if (!xhsWindow || xhsWindow.isDestroyed()) {
    void createXhsWindow();
    return;
  }
  if (xhsWindow.isVisible()) {
    hideXhsWindow();
  } else {
    showXhsWindow();
  }
}

export function destroyXhsWindow(): void {
  if (xhsWindow && !xhsWindow.isDestroyed()) {
    xhsWindow.destroy();
  }
  if (helperWindow && !helperWindow.isDestroyed()) {
    helperWindow.destroy();
  }
  xhsWindow = null;
  helperWindow = null;
  helperReady = null;
  listeners.clear();
}

