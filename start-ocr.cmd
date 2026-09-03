@echo off
rem 启动本地 ddddocr 验证码识别服务（比内置 Tesseract 更擅长扭曲/干扰线验证码）
setlocal
chcp 65001 >nul 2>nul
cd /d "%~dp0"
title Auto Verification Code - 本地识别服务 (ddddocr)

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo   找不到 Python。请先从 https://www.python.org 安装 Python 3.8-3.11。
  echo.
  pause
  exit /b 1
)

python "ocr-server\server.py" %*

echo.
echo   识别服务已停止。
pause
