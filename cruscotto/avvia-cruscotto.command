#!/bin/sh
# Avvio su Mac/Linux: doppio clic (Mac) oppure ./avvia-cruscotto.command
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null || { echo "Installa Node.js da https://nodejs.org (versione LTS)"; read -r _; exit 1; }
[ -d node_modules ] || npm install --omit=dev || exit 1
[ -f .env ] || cp .env.example .env
(sleep 1; open http://localhost:3100 2>/dev/null || xdg-open http://localhost:3100) &
exec node --disable-warning=ExperimentalWarning src/server.js
