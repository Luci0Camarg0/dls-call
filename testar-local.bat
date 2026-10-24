@echo off
chcp 65001 >nul
title DLS Call - servidor local (teste)
cd /d "%~dp0server"
if not exist node_modules call npm install --no-fund --no-audit
start "" http://localhost:3000
echo  Servidor de teste rodando em http://localhost:3000  (feche esta janela para parar)
node server.js
pause
