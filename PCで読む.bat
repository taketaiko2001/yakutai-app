@echo off
chcp 65001 >nul
title 薬袋プリント（PCで読む）
cd /d "%~dp0"
rem 読み取りの深さ: high（1枚 約5〜10秒） / medium（少し速い）。指定しないと考え込んで1枚 1〜2分かかる
set CLAUDE_EFFORT=high
node pc\server.js
pause
