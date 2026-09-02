@echo off
rem ---------------------------------------------------------------------------
rem  Auto Verification Code - 启动短信桥接服务
rem
rem  双击即可运行。脚本会切到自己所在的目录，所以整个仓库可以随便移动，
rem  不需要改任何路径。
rem
rem  也可以带参数：start-bridge.cmd --port 8788
rem ---------------------------------------------------------------------------
setlocal

rem 中文 Windows 的控制台默认是 GBK，切到 UTF-8 才能正常显示输出
chcp 65001 >nul 2>nul

rem %~dp0 = 本脚本所在目录（带结尾反斜杠），也就是项目根目录
cd /d "%~dp0"

title Auto Verification Code - SMS bridge

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   找不到 Node.js。
  echo.
  echo   请先从 https://nodejs.org 安装 Node.js 18 或更高版本，
  echo   安装完关掉这个窗口重新双击本脚本。
  echo.
  pause
  exit /b 1
)

if not exist "bridge\server.mjs" (
  echo.
  echo   在 %CD% 下找不到 bridge\server.mjs。
  echo   请把本脚本放在项目根目录下运行。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动桥接服务，关闭本窗口即可停止。
echo.

node "bridge\server.mjs" %*

rem 无论正常退出还是报错都停住，否则双击时窗口会一闪而过看不到原因
echo.
echo   桥接服务已停止。
pause
