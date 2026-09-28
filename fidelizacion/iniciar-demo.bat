@echo off
rem Demo de fidelizacion (HoraCeroIA): doble clic y listo.
rem Instala Node.js si hace falta, instala dependencias, crea datos de ejemplo y abre el panel.
chcp 65001 >nul
cd /d "%~dp0"
title Demo de fidelizacion - HoraCeroIA

if not exist "%~dp0package.json" goto :sin_extraer

rem Si el demo ya esta abierto, solo abrir el navegador.
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul
if not errorlevel 1 (
  start "" http://localhost:3000/admin
  exit /b 0
)

rem Node.js recien instalado todavia no esta en el PATH de esta ventana.
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"

where node >nul 2>nul
if errorlevel 1 call :instalar_node
where node >nul 2>nul
if errorlevel 1 goto :sin_node

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 call :instalar_node
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 goto :sin_node

if not exist node_modules (
  echo.
  echo  Preparando el demo, solo la primera vez. Puede tardar un par de minutos...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :error_npm
)

if not exist data\fidelizacion.db (
  echo  Creando clientes de ejemplo...
  call npm run reset
)

echo.
echo  ============================================================
echo    DEMO LISTO. Se abre el navegador en http://localhost:3000/admin
echo    Usuario: admin@demo.com     Contrasena: demo1234
echo.
echo    No cierres esta ventana mientras uses el demo.
echo  ============================================================
echo.
start "" /min cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:3000/admin"
call npm start
pause
exit /b 0

:instalar_node
echo.
echo  Instalando Node.js. Si Windows pide permiso, responde Si.
echo.
where winget >nul 2>nul
if errorlevel 1 exit /b 1
winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
set "PATH=%ProgramFiles%\nodejs;%PATH%"
exit /b 0

:sin_extraer
echo.
echo  Primero hay que descomprimir el archivo:
echo  clic derecho sobre fidelizacion-demo.zip, luego "Extraer todo",
echo  y abre este archivo desde la carpeta que se crea.
echo.
pause
exit /b 1

:sin_node
echo.
echo  No se pudo instalar Node.js automaticamente.
echo  Se abre la pagina de descarga: instala la version LTS y vuelve a abrir este archivo.
echo.
start "" https://nodejs.org/es/download
pause
exit /b 1

:error_npm
echo.
echo  No se pudieron descargar los componentes. Revisa tu conexion a internet y vuelve a intentar.
echo.
pause
exit /b 1
