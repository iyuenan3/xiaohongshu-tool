// Caddy edge root CA —— 客户端证书固定 (pinning) 的信任锚。
// 来源: bj edge Caddy `tls internal` 自签 root「Caddy Local Authority - 2026 ECC Root」
//   self-signed, 有效期 2026-05-23 → 2036-03-31 (~10 年长效)
//   SHA-256: 4C:81:89:49:0A:81:E3:D0:D9:0E:8D:35:98:E2:0E:D1:3C:E2:15:B6:12:63:39:29:07:24:D7:17:73:76:19:ED
// 用途: cert-pinning.ts 验证服务器证书链是否锚定到此 root, 防 license/LLM 自签链路 MITM。
// 公开证书 (非私钥), 可进 git。
// ⚠️ 此 root 变更 = 全体客户端连不上。前提: bj edge Caddy `/data` 持久化 (否则容器重建换 CA)。
//    CA 轮换 (重装/迁移/2036 过期) 时: 换此 PEM + 发新版客户端。Caddy 自动轮换的 intermediate/leaf 不影响。
export const PINNED_ROOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBpDCCAUqgAwIBAgIRAOGrQ57Pwm4FzlDzPVkcPUMwCgYIKoZIzj0EAwIwMDEu
MCwGA1UEAxMlQ2FkZHkgTG9jYWwgQXV0aG9yaXR5IC0gMjAyNiBFQ0MgUm9vdDAe
Fw0yNjA1MjMxNjUxMzlaFw0zNjAzMzExNjUxMzlaMDAxLjAsBgNVBAMTJUNhZGR5
IExvY2FsIEF1dGhvcml0eSAtIDIwMjYgRUNDIFJvb3QwWTATBgcqhkjOPQIBBggq
hkjOPQMBBwNCAAQhHJMdyZp0JEO7GgPYNrRRlp5RdIXuDpcVRQ9WZd366ijLMaBn
5+PuOn1RvVMeq+cGduWOj60F5P14GYGNBt6go0UwQzAOBgNVHQ8BAf8EBAMCAQYw
EgYDVR0TAQH/BAgwBgEB/wIBATAdBgNVHQ4EFgQUfdiI9DtJqZDWsSG75kWUHXE/
EAIwCgYIKoZIzj0EAwIDSAAwRQIgDGbCsS4YxaOHDkP4Zh/0BlvCEihvQez2KM8c
3jk0r70CIQDf1ziarPrx1bZSEZTL0t4uFKozW7qW6Srv2EZ+bHtiOg==
-----END CERTIFICATE-----
`;
