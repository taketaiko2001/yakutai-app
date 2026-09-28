@echo off
chcp 65001 >nul
title 薬袋プリント（PCで読む）
cd /d "%~dp0"
rem 読み取るモデル: opus（手書きに強い） / sonnet（速いが手書きの読み違いが多い）
set CLAUDE_MODEL=opus
rem 考える深さ: low（1枚 約7秒） / medium（約10秒・少し正確）
set CLAUDE_EFFORT=low
node pc\server.js
pause
