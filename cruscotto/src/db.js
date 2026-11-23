'use strict';
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(path.join(config.datiDir, 'cruscotto.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS clienti (
  id        INTEGER PRIMARY KEY,
  nome      TEXT NOT NULL,
  telefono  TEXT,
  email     TEXT,
  note      TEXT,
  creato_il TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pratiche (
  id              INTEGER PRIMARY KEY,
  cliente_id      INTEGER REFERENCES clienti(id) ON DELETE SET NULL,
  commessa        TEXT,
  indirizzo       TEXT,
  tipo            TEXT NOT NULL,
  ente            TEXT,
  oggetto         TEXT,
  stato           TEXT NOT NULL,
  protocollo      TEXT,
  data_protocollo TEXT,
  numero_pratica  TEXT,
  onorario_cent   INTEGER NOT NULL DEFAULT 0,
  note            TEXT,
  creato_il       TEXT NOT NULL DEFAULT (datetime('now')),
  aggiornato_il   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS pratiche_cliente ON pratiche(cliente_id);

CREATE TABLE IF NOT EXISTS scadenze (
  id          INTEGER PRIMARY KEY,
  pratica_id  INTEGER NOT NULL REFERENCES pratiche(id) ON DELETE CASCADE,
  descrizione TEXT NOT NULL,
  data        TEXT NOT NULL,
  fatta       INTEGER NOT NULL DEFAULT 0,
  fatta_il    TEXT,
  creato_il   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS scadenze_data ON scadenze(fatta, data);

CREATE TABLE IF NOT EXISTS attivita (
  id          INTEGER PRIMARY KEY,
  pratica_id  INTEGER NOT NULL REFERENCES pratiche(id) ON DELETE CASCADE,
  testo       TEXT NOT NULL,
  fatta       INTEGER NOT NULL DEFAULT 0,
  fatta_il    TEXT,
  creato_il   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS incassi (
  id           INTEGER PRIMARY KEY,
  pratica_id   INTEGER NOT NULL REFERENCES pratiche(id) ON DELETE CASCADE,
  data         TEXT NOT NULL,
  importo_cent INTEGER NOT NULL,
  descrizione  TEXT,
  creato_il    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comunicazioni (
  id           INTEGER PRIMARY KEY,
  pratica_id   INTEGER NOT NULL REFERENCES pratiche(id) ON DELETE CASCADE,
  canale       TEXT NOT NULL CHECK (canale IN ('email','whatsapp')),
  destinatario TEXT NOT NULL,
  oggetto      TEXT,
  testo        TEXT NOT NULL,
  creato_il    TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;
