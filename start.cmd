@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if exist "config.cmd" call "config.cmd"
set "LAN_NODE=%~dp0runtime\node.exe"
if not exist "%LAN_NODE%" set "LAN_NODE=node"
"%LAN_NODE%" -e "if(!(Number(process.versions.node.split('.')[0])>=24)) process.exit(1)" >nul 2>nul
if errorlevel 1 (
  echo 需要 Node.js 24 或更新版本。请使用完整离线运行包，或安装 Node.js。
  pause
  exit /b 1
)
"%LAN_NODE%" server.mjs --open %*
if errorlevel 1 pause
endlocal
