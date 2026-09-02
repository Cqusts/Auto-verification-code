#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Auto Verification Code - 启动短信桥接服务（macOS / Linux）
#
#  双击或 ./start-bridge.sh 运行。脚本会切到自己所在的目录，
#  所以整个仓库可以随便移动，不需要改任何路径。
#
#  也可以带参数：./start-bridge.sh --port 8788
# ---------------------------------------------------------------------------
set -u

# 本脚本所在目录 = 项目根目录，即使通过软链接调用也能解析对
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  找不到 Node.js。"
  echo "  请先安装 Node.js 18 或更高版本：https://nodejs.org"
  echo
  read -r -p "按回车键退出…" _
  exit 1
fi

if [ ! -f "bridge/server.mjs" ]; then
  echo
  echo "  在 $ROOT 下找不到 bridge/server.mjs。"
  echo "  请把本脚本放在项目根目录下运行。"
  echo
  read -r -p "按回车键退出…" _
  exit 1
fi

echo
echo "  正在启动桥接服务，按 Ctrl+C 或关闭本窗口即可停止。"
echo

node "bridge/server.mjs" "$@"

# 双击运行时窗口会立刻关闭，停住让人能看到退出原因
echo
echo "  桥接服务已停止。"
read -r -p "按回车键退出…" _
