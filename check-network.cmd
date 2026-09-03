@echo off
rem 网络自检：定位「手机发不过来」卡在哪一段
setlocal
chcp 65001 >nul 2>nul
cd /d "%~dp0"
title Auto Verification Code - 网络自检
node "scripts\doctor.mjs" %*
echo.
pause
