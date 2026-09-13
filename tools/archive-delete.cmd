@echo off
rem Double-clickable wrapper for tools/archive-delete.mjs.
rem
rem Drag a novel project folder onto this file, or double-click it and type the
rem path when the script asks. It always shows the dry run first and asks before
rem deleting anything.
rem
rem Everything interactive happens inside the Node script, NOT here: `chcp`
rem (needed so the Chinese output is not mangled on a GBK console) breaks cmd's
rem `set /p` when input is redirected, and the whole point of this file is to be
rem runnable by double-click. ASCII-only text here, for the same reason.
chcp 65001 >nul
cd /d "%~dp0.."
node --experimental-transform-types tools\archive-delete.mjs %*
echo.
pause
