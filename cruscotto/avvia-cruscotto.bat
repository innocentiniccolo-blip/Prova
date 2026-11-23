@echo off
title Cruscotto pratiche
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js non e' installato.
  echo  Scaricalo da https://nodejs.org  ^(versione LTS^), installalo e riapri questo file.
  echo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Prima installazione: scarico i componenti necessari...
  call npm install --omit=dev
  if errorlevel 1 ( pause & exit /b 1 )
)
if not exist .env copy .env.example .env >nul
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3100"
node --disable-warning=ExperimentalWarning src\server.js
pause
