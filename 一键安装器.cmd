@echo off
setlocal
cd /d "%~dp0"

echo.
echo  B站字幕桌面歌词 - 一键安装器
echo  正在登记透明桌面助手，请稍候...
echo.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0一键安装器.ps1"
set "exitCode=%ERRORLEVEL%"

if not "%exitCode%"=="0" (
  echo.
  echo [安装失败] 请先打开同目录的“请先看教程-一键安装与使用.html”。
  pause
  exit /b %exitCode%
)

echo.
echo [第一步已完成] 透明桌面助手已经登记。
echo 接下来请在刚打开的扩展管理页点击“加载已解压的扩展程序”。
echo 选择当前这个文件夹，然后刷新 B 站视频页即可。
echo.
pause
