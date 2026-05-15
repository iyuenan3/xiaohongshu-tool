// CDP endpoint 管理: 启动前选择空闲端口, 启动后从 /json/version 获取 wsUrl。

import { createServer } from 'net';
import log from 'electron-log/main';

/**
 * pickFreePort 让操作系统选择一个 127.0.0.1 上的空闲端口, 关闭 listener 后返回。
 *
 * TOCTOU: 关闭 listener 到 Electron 实际 bind 之间, 极小概率被抢占。
 * 实测下来稳定, 如要绝对保证可改为 listener 直接传给 Electron (但 Electron 不支持)。
 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen({ port: 0, host: '127.0.0.1' }, () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error('listen addr invalid'));
      }
    });
  });
}

/**
 * 从 Electron 的 DevTools HTTP endpoint 拿到浏览器级 WebSocket URL。
 *
 * Electron 启动时若加了 --remote-debugging-port=<port>, 会监听 HTTP 127.0.0.1:port。
 * GET /json/version 返回 { webSocketDebuggerUrl: "ws://127.0.0.1:port/devtools/browser/<uuid>" }。
 *
 * 这是 go-rod ControlURL 需要的浏览器级 endpoint (区别于 page 级 /devtools/page/<id>)。
 *
 * @param port  Electron --remote-debugging-port
 * @param retry 启动初期 DevTools server 可能还没绑端口, 重试 N 次
 */
export async function getElectronCdpWsUrl(port: number, retry = 20): Promise<string> {
  let lastErr: unknown = null;
  for (let i = 0; i < retry; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        const j = (await r.json()) as { webSocketDebuggerUrl?: string };
        if (j.webSocketDebuggerUrl) {
          log.info(`[cdp] wsUrl=${j.webSocketDebuggerUrl}`);
          return j.webSocketDebuggerUrl;
        }
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(
    `getElectronCdpWsUrl failed after ${retry} retries: ${String(lastErr)}`,
  );
}
