#!/bin/bash
# 解除 macOS quarantine 标记, 让无 Apple Developer ID 签名的应用能正常打开。
# 用户双击此文件 → Terminal 弹出 → 跑 xattr -cr → 提示完成 → 之后双击应用即可。

set -e

APP_PATH="/Applications/小红书自运营.app"

clear
cat <<'EOF'
╔══════════════════════════════════════════════════════════════╗
║         小红书自运营系统 · 首次安装                          ║
║                                                              ║
║   macOS 安全策略要求首次解除「已下载」标记, 否则会拦截无证书 ║
║   应用。本脚本会执行:                                        ║
║     xattr -cr /Applications/小红书自运营.app                 ║
║                                                              ║
║   完成后, 双击 Applications 里的「小红书自运营」即可正常使用。║
╚══════════════════════════════════════════════════════════════╝

EOF

if [ ! -d "$APP_PATH" ]; then
  echo "❌ 未找到 $APP_PATH"
  echo "   请先把 dmg 里的「小红书自运营」拖到 Applications 文件夹, 再双击本脚本。"
  echo ""
  echo "按任意键退出..."
  read -n 1 -s
  exit 1
fi

echo "正在解除安全限制..."
xattr -cr "$APP_PATH"
echo "✓ 完成。现在可以双击「小红书自运营」打开。"
echo ""

# 弹个原生确认框
osascript -e 'display dialog "首次安装完成! 现在可以双击 Applications 里的「小红书自运营」启动。" buttons {"好"} default button "好" with icon note with title "小红书自运营"' >/dev/null 2>&1 || true

# 用户可选: 立刻启动
osascript -e 'tell application "Finder" to activate' >/dev/null 2>&1 || true
open "$APP_PATH"
