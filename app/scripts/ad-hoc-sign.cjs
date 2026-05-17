// electron-builder afterPack hook: 给 macOS .app 做 ad-hoc codesign
// 解决 macOS Sequoia/Tahoe 把无签名 dmg 误判为「已损坏」。仍是无证书自签, 用户首启需右键打开。
// Linux/Windows 平台无操作。

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adHocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  console.log(`[ad-hoc-sign] signing ${appPath}`);
  try {
    execFileSync(
      'codesign',
      ['--force', '--deep', '--sign', '-', appPath],
      { stdio: 'inherit' },
    );
    console.log('[ad-hoc-sign] done');
  } catch (e) {
    console.error('[ad-hoc-sign] failed:', e.message);
    throw e;
  }
};
