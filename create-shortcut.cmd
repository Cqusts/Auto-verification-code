@echo off
rem ---------------------------------------------------------------------------
rem  Auto Verification Code - 在桌面创建启动快捷方式
rem
rem  双击运行一次即可。之后直接点桌面上的图标就能启动桥接服务，
rem  不用再进到项目目录里来。
rem
rem  想移除：create-shortcut.cmd --remove
rem ---------------------------------------------------------------------------
setlocal
chcp 65001 >nul 2>nul
cd /d "%~dp0"
title Auto Verification Code - 创建桌面快捷方式

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   找不到 Node.js。请先从 https://nodejs.org 安装。
  echo.
  pause
  exit /b 1
)

node "scripts\make-shortcut.mjs" %*

echo.
pause
