@echo off
chcp 65001 >nul
title 薬袋プリント（PCで読む）
cd /d "%~dp0"
node pc\server.js
pause
