@echo off
chcp 65001 >nul
title DLS Call - gerar o .exe
cd /d "%~dp0desktop"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js nao encontrado. Instale a versao LTS em https://nodejs.org e rode de novo.
  pause
  exit /b 1
)

echo.
echo  === DLS Call - gerar o .exe ===
echo.
echo  Cole o endereco do seu servidor (exemplo: https://dls-call.onrender.com)
set /p URL= Endereco:
if "%URL%"=="" (
  echo  Nenhum endereco digitado.
  pause
  exit /b 1
)

> config.json echo {"serverUrl": "%URL%"}

if not exist node_modules\electron\dist\electron.exe (
  echo.
  echo  Baixando as ferramentas - so na primeira vez, pode demorar...
  call npm install --no-fund --no-audit
  call node node_modules\electron\install.js
)

echo.
echo  Gerando o .exe...
call npx electron-builder --win
if errorlevel 1 (
  echo  Algo deu errado ao gerar o .exe.
  pause
  exit /b 1
)

echo.
echo  Pronto! Os arquivos estao na pasta desktop\dist:
echo    DLS-Call.exe            - abre direto, sem instalar
echo    DLS-Call-Instalador.exe - instala e cria atalho
explorer dist
pause
