@echo off
rem Demo de fidelizacion: doble clic para instalar (la primera vez) y arrancar.
chcp 65001 >nul
cd /d "%~dp0"
title Demo de fidelizacion - HoraCeroIA

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Falta Node.js. Instala la version LTS desde https://nodejs.org y vuelve a abrir este archivo.
  echo.
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo.
  echo  Tu version de Node.js es muy vieja. Instala la version LTS desde https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo  Instalando dependencias, solo la primera vez...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

if not exist data\fidelizacion.db (
  echo  Creando datos de ejemplo...
  call npm run reset
)

echo.
echo  Abriendo el panel en el navegador: http://localhost:3000/admin
echo  Usuario: admin@demo.com   Contrasena: demo1234
echo  Para detener el demo cierra esta ventana.
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000/admin"
call npm start
pause
