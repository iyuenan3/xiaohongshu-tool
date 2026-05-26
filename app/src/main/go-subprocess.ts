// Go subprocess 管理: 启动 xiaohongshu-mcp 二进制, 解析 BIND_PORT, HTTP 通信, 优雅停止。

import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { app } from 'electron';
import log from 'electron-log/main';

export interface GoSubprocessStartOptions {
  binPath: string;
  userDataDir: string;
  port?: string; // 默认 "127.0.0.1:0" (随机)
}

export interface GoSubprocessStartResult {
  port: number;
  baseUrl: string;
}

export class GoSubprocess {
  private proc?: ChildProcess;
  private port?: number;
  private startResolve?: (r: GoSubprocessStartResult) => void;
  private startReject?: (e: Error) => void;

  /** 启动 Go 子进程, 等到 stdout 出现 BIND_PORT=<n> 才 resolve. 超时 10s. */
  start(opts: GoSubprocessStartOptions): Promise<GoSubprocessStartResult> {
    return new Promise<GoSubprocessStartResult>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;

      const args = [
        `--port=${opts.port ?? '127.0.0.1:0'}`,
        // 注意: 不传 --cdp-endpoint, attach 后由 POST /internal/attach 注入。
        // 也不传 --headless (attach 模式下无意义), 但 launcher 模式需要 false 才能看见 (默认 true=headless)
        '--headless=false',
      ];

      log.info(`[go] spawning: ${opts.binPath} ${args.join(' ')}`);

      const child = spawn(opts.binPath, args, {
        env: {
          ...process.env,
          XHS_USER_DATA_DIR: opts.userDataDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.proc = child;

      const timeout = setTimeout(() => {
        if (this.startReject) {
          this.startReject(new Error('Go subprocess did not emit BIND_PORT within 10s'));
          this.startReject = undefined;
          this.startResolve = undefined;
          this.stop().catch(() => undefined);
        }
      }, 10_000);

      const handleStdoutLine = (line: string) => {
        log.info(`[go:stdout] ${line}`);
        const m = line.match(/^BIND_PORT=(\d+)$/);
        if (m && this.startResolve) {
          this.port = Number(m[1]);
          const baseUrl = `http://127.0.0.1:${this.port}`;
          log.info(`[go] ready at ${baseUrl}`);
          clearTimeout(timeout);
          this.startResolve({ port: this.port, baseUrl });
          this.startResolve = undefined;
          this.startReject = undefined;
        }
      };

      let stdoutBuf = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        let idx: number;
        while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, idx).trimEnd();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (line.length > 0) handleStdoutLine(line);
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trimEnd();
        if (text) log.info(`[go:stderr] ${text}`);
      });

      child.on('exit', (code, signal) => {
        log.info(`[go] exited code=${code} signal=${signal}`);
        clearTimeout(timeout);
        if (this.startReject) {
          this.startReject(new Error(`Go subprocess exited before ready (code=${code} signal=${signal})`));
          this.startReject = undefined;
          this.startResolve = undefined;
        }
        this.proc = undefined;
      });

      child.on('error', (err) => {
        log.error(`[go] spawn error: ${err.message}`);
        clearTimeout(timeout);
        if (this.startReject) {
          this.startReject(err);
          this.startReject = undefined;
          this.startResolve = undefined;
        }
      });
    });
  }

  /** SIGTERM, 等 3s, 否则 SIGKILL. */
  async stop(): Promise<void> {
    if (!this.proc) return;
    const child = this.proc;
    this.proc = undefined;

    return new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        log.warn('[go] SIGTERM 超时, 发送 SIGKILL');
        child.kill('SIGKILL');
      }, 3000);

      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });

      child.kill('SIGTERM');
    });
  }

  baseUrl(): string {
    if (!this.port) throw new Error('GoSubprocess not started');
    return `http://127.0.0.1:${this.port}`;
  }

  async health(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl()}/health`);
      return r.ok;
    } catch {
      return false;
    }
  }

  /** 注入 CDP endpoint, 让 Go 端 attach. */
  async attachCDP(wsUrl: string): Promise<void> {
    const r = await fetch(`${this.baseUrl()}/internal/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cdp_endpoint: wsUrl }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`/internal/attach failed: HTTP ${r.status}: ${text}`);
    }
    log.info(`[go] CDP attach OK`);
  }

  async callApi<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    // GET/HEAD 不允许 body. body 为空对象 / null / undefined 时也不发 body.
    const hasBody =
      method !== 'GET' &&
      method !== 'HEAD' &&
      body != null &&
      !(typeof body === 'object' && Object.keys(body as object).length === 0);
    // 兜底超时: 发布/互动正常 <100s, 最坏(多图慢网)~200s。240s 后 abort,
    // 避免 Go 端卡死时 renderer 靠 undici 默认行为干等 ~5 分钟后才 fetch failed。
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 240_000);
    let r: Response;
    try {
      r = await fetch(`${this.baseUrl()}${path}`, {
        method,
        headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
        body: hasBody ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
    } catch (e) {
      if (ac.signal.aborted) {
        throw new Error(`API ${method} ${path} 超时(240s)，操作可能未完成，请稍后重试`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    const json = (await r.json()) as T;
    if (!r.ok) {
      throw new Error(`API ${method} ${path} failed: HTTP ${r.status}: ${JSON.stringify(json)}`);
    }
    return json;
  }
}

/** 解析打包后的 Go 二进制路径 (dev 模式从 resources/bin/, 生产模式从 process.resourcesPath) */
export function resolveGoBinaryPath(): string {
  const binName = process.platform === 'win32' ? 'xiaohongshu-mcp.exe' : 'xiaohongshu-mcp';
  const isPackaged = app.isPackaged;
  if (isPackaged) {
    return join(process.resourcesPath, 'bin', binName);
  }
  // dev: 从 app/ 项目根的 resources/bin/
  return join(app.getAppPath(), 'resources', 'bin', binName);
}
