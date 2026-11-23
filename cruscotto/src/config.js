'use strict';
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');

// Legge il file .env accanto al programma (comodo su Windows: niente variabili di sistema da impostare)
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* .env facoltativo */ }

const config = {
  port: Number(process.env.PORTA || process.env.PORT) || 3100,
  // Il cruscotto ascolta SOLO sul PC stesso: nessun altro dispositivo può collegarsi.
  host: '127.0.0.1',
  datiDir: path.resolve(process.env.DATI_DIR || path.join(root, 'dati')),
  studio: JSON.parse(fs.readFileSync(process.env.STUDIO_CONFIG || path.join(root, 'config', 'studio.json'), 'utf8')),
};

fs.mkdirSync(config.datiDir, { recursive: true });

module.exports = config;
