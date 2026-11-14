'use strict';
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const studioFile = process.env.STUDIO_CONFIG || path.join(root, 'config', 'studio.json');

const config = {
  port: Number(process.env.PORT) || 3000,
  // Cartella del NAS che contiene le cartelle dei lavori (montata nel container)
  archivioDir: path.resolve(process.env.ARCHIVIO_DIR || path.join(root, 'dati', 'lavori')),
  // Cartella per database e file interni dell'app
  datiDir: path.resolve(process.env.DATI_DIR || path.join(root, 'dati', 'app')),
  sessionSecret: process.env.SESSION_SECRET || '',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  trustProxy: process.env.TRUST_PROXY || false,
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB) || 200,
  produzione: process.env.NODE_ENV === 'production',
  studio: JSON.parse(fs.readFileSync(studioFile, 'utf8')),
};

if (!config.sessionSecret) {
  if (config.produzione) {
    throw new Error('SESSION_SECRET mancante: impostalo nel file .env');
  }
  config.sessionSecret = 'solo-sviluppo-non-usare-in-produzione';
}

fs.mkdirSync(config.archivioDir, { recursive: true });
fs.mkdirSync(config.datiDir, { recursive: true });

module.exports = config;
