#!/usr/bin/env bash
# 启动本地 ddddocr 验证码识别服务（比内置 Tesseract 更擅长扭曲/干扰线验证码）
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1

PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo
  echo "  找不到 Python。请先安装 Python 3.8-3.11：https://www.python.org"
  echo
  read -r -p "按回车键退出…" _
  exit 1
fi

"$PY" "ocr-server/server.py" "$@"

echo
echo "  识别服务已停止。"
read -r -p "按回车键退出…" _
