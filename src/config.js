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
  // true = niente pagina di presentazione: l'indirizzo apre subito l'accesso (es. area.geometrainnocenti.it)
  soloArea: process.env.SOLO_AREA === 'true',
  // Indirizzo pubblico dell'app, usato nei link delle email (es. https://area.geometrainnocenti.it)
  urlPubblico: String(process.env.URL_PUBBLICO || '').replace(/\/+$/, ''),
  // Invio email (password dimenticata, benvenuto). Se SMTP_HOST è vuoto le email sono disattivate.
  posta: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 465,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    mittente: process.env.MAIL_FROM || process.env.SMTP_USER || '',
  },
  studio: JSON.parse(fs.readFileSync(studioFile, 'utf8')),
};

fs.mkdirSync(config.datiDir, { recursive: true });
try { fs.mkdirSync(config.archivioDir, { recursive: true }); } catch { /* archivio montato in sola lettura */ }

// Chiave delle sessioni: se non è impostata nel .env, l'app ne crea una casuale
// al primo avvio e la conserva nella cartella dati (che resta privata sul NAS).
if (!config.sessionSecret) {
  const file = path.join(config.datiDir, 'chiave-sessioni');
  try {
    config.sessionSecret = fs.readFileSync(file, 'utf8').trim();
  } catch {
    config.sessionSecret = require('node:crypto').randomBytes(32).toString('hex');
    fs.writeFileSync(file, config.sessionSecret, { mode: 0o600 });
  }
}

module.exports = config;
