@echo off
chcp 65001 >nul
title OBS X Son Dakika v4
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js bulunamadi. Node.js 18 veya ustunu kurun.
  pause
  exit /b 1
)
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo .env dosyasi olusturuldu. X_BEARER_TOKEN satirini doldurun.
  notepad ".env"
  pause
  exit /b 0
)
if not exist "node_modules" (
  call npm install
  if errorlevel 1 (
    echo npm install basarisiz.
    pause
    exit /b 1
  )
)
start "" "http://127.0.0.1:8787/admin.html"
node server.js
pause
