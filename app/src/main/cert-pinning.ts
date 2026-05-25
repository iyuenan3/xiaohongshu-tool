// 证书固定 (certificate pinning) —— 客户端只信任由打包 Caddy root CA 签发的自签证书。
// 防 license/LLM 自签链路被 MITM (攻击者无 pinned root 私钥, 签不出被信任的证书)。
// 正常公网 HTTPS (CA 签发, isIssuedByKnownRoot) 不受影响, 走 Chromium 默认校验。
// 不写死 host: 只要证书链锚定到 pinned root 即信任 → LLM endpoint 迁移到新 host/IP 也自动放行。
import { X509Certificate } from 'node:crypto';
import type { App, Certificate, Session } from 'electron';
import { PINNED_ROOT_CA_PEM } from './pinned-ca';

// 解析一次; PEM 损坏 → null → 下方 fail-closed (一律拒自签)。
let pinnedRoot: X509Certificate | null = null;
try {
  pinnedRoot = new X509Certificate(PINNED_ROOT_CA_PEM);
} catch {
  pinnedRoot = null;
}

// 验证 Electron 证书 (leaf + 服务器发的 issuerCert intermediate) 链是否由 pinned root 签发。
// fail-closed: 无 pinnedRoot / 缺数据 / 验签异常 → false (宁拒勿放)。
export function isAnchoredToPinnedRoot(leafCert: Certificate | undefined): boolean {
  if (!pinnedRoot || !leafCert?.data) return false;
  try {
    const leaf = new X509Certificate(leafCert.data);
    const interData = leafCert.issuerCert?.data;
    if (interData && interData !== leafCert.data) {
      const inter = new X509Certificate(interData);
      // leaf 由 intermediate 签 && intermediate 由 pinned root 签
      return leaf.verify(inter.publicKey) && inter.verify(pinnedRoot.publicKey);
    }
    // 没收到 intermediate: 兜底验 leaf 直接由 root 签
    return leaf.verify(pinnedRoot.publicKey);
  } catch {
    return false;
  }
}

// 安装两个证书校验钩子: 主进程 net.fetch 的 verifyProc + renderer 的 certificate-error。
export function installCertPinning(
  session: Session,
  app: App,
  log: { info: (m: string) => void; warn: (m: string) => void },
): void {
  // 主进程 net.fetch (license/version/LLM via defaultSession) 的证书校验
  session.setCertificateVerifyProc((req, callback) => {
    if (req.isIssuedByKnownRoot) {
      callback(-3); // 正常 CA → 沿用 Chromium 默认校验
      return;
    }
    if (isAnchoredToPinnedRoot(req.certificate)) {
      callback(0); // 自签但锚定 pinned root → 信任
      return;
    }
    log.warn(`[cert-pin] reject unanchored self-signed: ${req.hostname}`);
    callback(-2); // 其余自签 → 拒
  });

  // renderer / webContents 证书错误 (Chromium 默认校验失败才触发)
  app.on('certificate-error', (event, _wc, url, _error, cert, callback) => {
    if (isAnchoredToPinnedRoot(cert)) {
      event.preventDefault();
      callback(true); // 锚定 pinned root → 信任
      return;
    }
    log.warn(`[cert-pin] reject invalid cert: ${url}`);
    callback(false);
  });
}
