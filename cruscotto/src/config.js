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
  drive: {
    // Cartella dello studio dentro Google Drive per desktop. Vuoto = la cerco da solo (es. G:\Il mio Drive\Studio Innocenti)
    dir: (process.env.DRIVE_DIR || '').trim(),
    nomeCartella: (process.env.DRIVE_CARTELLA || 'Studio Innocenti').trim(),
  },
  whatsapp: {
    // Cartella (dentro quella dello studio su Drive) dove salvare le chat esportate da WhatsApp
    cartella: (process.env.WHATSAPP_CARTELLA || '_WhatsApp da importare').trim(),
    // Il tuo nome come appare nelle chat esportate (se vuoto lo riconosco da solo). Più nomi separati da virgola.
    mieiNomi: (process.env.WHATSAPP_MIO_NOME || '').split(',').map((s) => s.trim()).filter(Boolean),
    minuti: Math.max(Number(process.env.WHATSAPP_CONTROLLO_MINUTI) || 10, 1),
  },
  posta: {
    indirizzo: (process.env.EMAIL_INDIRIZZO || '').trim(),
    password: process.env.EMAIL_PASSWORD || '',
    nome: process.env.EMAIL_NOME || '',
    imap: { host: process.env.IMAP_HOST || 'imaps.aruba.it', port: Number(process.env.IMAP_PORTA) || 993, secure: process.env.IMAP_SSL !== 'false' },
    smtp: { host: process.env.SMTP_HOST || 'smtps.aruba.it', port: Number(process.env.SMTP_PORTA) || 465, secure: process.env.SMTP_SSL !== 'false' },
    minuti: Math.max(Number(process.env.EMAIL_CONTROLLO_MINUTI) || 5, 1),
    giorniIniziali: Number(process.env.EMAIL_GIORNI_INIZIALI) || 14,
    // clienti = bozza automatica solo per mail di clienti in rubrica o abbinate a una pratica; tutte; no
    bozzeAutomatiche: ['clienti', 'tutte', 'no'].includes(process.env.EMAIL_BOZZE_AUTOMATICHE) ? process.env.EMAIL_BOZZE_AUTOMATICHE : 'clienti',
  },
  studio: JSON.parse(fs.readFileSync(process.env.STUDIO_CONFIG || path.join(root, 'config', 'studio.json'), 'utf8')),
};

fs.mkdirSync(config.datiDir, { recursive: true });
if (!config.posta.nome) config.posta.nome = config.studio.nomeBreve;
config.posta.attiva = Boolean(config.posta.indirizzo && config.posta.password);

module.exports = config;
