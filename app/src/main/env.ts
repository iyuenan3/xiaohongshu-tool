import { app, screen } from 'electron';
import os from 'os';
import log from 'electron-log/main';
import { licenseManager } from './license';

// 启动时 dump 一段 banner, 把诊断需要的所有环境信息一次写入 log
// 设计原则: 包括看 bug 所需上下文, 但绝不 dump 敏感数据 (BYOK key / 完整 machine_id / 完整激活码)
export async function logEnvironment(): Promise<void> {
  try {
    const lic = await licenseManager.getStatus().catch(() => null);
    const machineId = (() => {
      try { return licenseManager.getMachineIdPublic(); } catch { return ''; }
    })();
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const total = os.totalmem();
    const free = os.freemem();
    const cpus = os.cpus();

    log.info('==================== environment ====================');
    log.info(`[env] app version:    ${app.getVersion()}`);
    log.info(`[env] electron:       ${process.versions.electron}`);
    log.info(`[env] chrome:         ${process.versions.chrome}`);
    log.info(`[env] node:           ${process.versions.node}`);
    log.info(`[env] v8:             ${process.versions.v8}`);
    log.info(`[env] platform:       ${process.platform} ${os.release()}`);
    log.info(`[env] arch:           ${process.arch}`);
    log.info(`[env] cpu:            ${cpus[0]?.model ?? 'unknown'} x ${cpus.length}`);
    log.info(`[env] memory:         total ${gb(total)} GB / free ${gb(free)} GB`);
    log.info(`[env] locale:         ${app.getLocale()}`);
    log.info(`[env] sys language:   ${app.getPreferredSystemLanguages().slice(0, 3).join(',')}`);
    log.info(`[env] timezone:       ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
    log.info(`[env] isPackaged:     ${app.isPackaged}`);
    log.info(`[env] resourcesPath:  ${process.resourcesPath ?? 'n/a'}`);
    log.info(`[env] userData:       ${app.getPath('userData')}`);
    log.info(`[env] logFile:        ${log.transports.file.getFile().path}`);

    for (let i = 0; i < displays.length; i++) {
      const d = displays[i];
      const isPrimary = d.id === primary.id ? ' (primary)' : '';
      log.info(
        `[env] display[${i}]:     ${d.size.width}x${d.size.height} @${d.scaleFactor}x  ` +
        `workArea=${d.workArea.width}x${d.workArea.height}  rotation=${d.rotation}  ` +
        `internal=${d.internal}${isPrimary}`,
      );
    }

    if (lic) {
      const codeTail = lic.code ? `...${lic.code.slice(-4)}` : 'n/a';
      const validUntil = lic.valid_until ? new Date(lic.valid_until * 1000).toISOString() : 'n/a';
      log.info(
        `[env] license:        status=${lic.status}  code=${codeTail}  ` +
        `machineId=${machineId ? machineId.slice(0, 8) + '...' : 'n/a'}  ` +
        `valid_until=${validUntil}`,
      );
    } else {
      log.info('[env] license:        (read failed)');
    }

    log.info('=====================================================');
  } catch (e) {
    log.warn(`[env] dump failed: ${String(e)}`);
  }
}

function gb(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(2);
}
