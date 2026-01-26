@echo off

REM Ouvre une fenêtre pour le client et lance "npm run dev -- --host"
start "Client" powershell -NoExit -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '%~dp0client'; npm run dev -- --host"

REM Ouvre une autre fenêtre pour le server et lance "node server.js"
start "Server" powershell -NoExit -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '%~dp0server'; node server.js"

exit /b