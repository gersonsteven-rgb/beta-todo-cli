#!/bin/sh
# Demo de fidelización: doble clic en Mac (o ./iniciar-demo.command en Linux).
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Falta Node.js. Instalá la versión LTS desde https://nodejs.org y volvé a abrir este archivo."
  read -r _; exit 1
fi
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"; then
  echo "Tu versión de Node.js es muy vieja. Instalá la versión LTS desde https://nodejs.org"
  read -r _; exit 1
fi

[ -d node_modules ] || { echo "Instalando dependencias (solo la primera vez)..."; npm install || exit 1; }
[ -f data/fidelizacion.db ] || { echo "Creando datos de ejemplo..."; npm run reset; }

echo ""
echo "Panel: http://localhost:3000/admin  (admin@demo.com / demo1234)"
echo "Para detener el demo: Ctrl+C o cerrá esta ventana."
echo ""
( sleep 3; (open "http://localhost:3000/admin" || xdg-open "http://localhost:3000/admin") >/dev/null 2>&1 ) &
npm start
