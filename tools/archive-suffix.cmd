@echo off
rem Double-clickable wrapper for tools/archive-suffix.mjs.
rem
rem Add the .archived suffix (hide archived files from the plugin):
rem     double-click, or drop a novel project folder on this file
rem     then:   node --experimental-transform-types tools/archive-suffix.mjs <root> --apply
rem
rem Take the suffix off again:
rem     node --experimental-transform-types tools/archive-suffix.mjs <root> --restore --apply
rem
rem Everything interactive happens inside the Node script (see archive-delete.cmd
rem for why). ASCII-only text here.
chcp 65001 >nul
cd /d "%~dp0.."
node --experimental-transform-types tools\archive-suffix.mjs %*
echo.
pause
