'use strict';
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(path.join(config.datiDir, 'studio.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS utenti (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  nome          TEXT NOT NULL,
  telefono      TEXT,
  ruolo         TEXT NOT NULL DEFAULT 'cliente' CHECK (ruolo IN ('admin','cliente')),
  attivo        INTEGER NOT NULL DEFAULT 1,
  creato_il     TEXT NOT NULL DEFAULT (datetime('now')),
  ultimo_accesso TEXT
);

CREATE TABLE IF NOT EXISTS lavori (
  id           INTEGER PRIMARY KEY,
  codice       TEXT NOT NULL UNIQUE,
  titolo       TEXT NOT NULL,
  descrizione  TEXT,
  indirizzo    TEXT,
  stato        TEXT NOT NULL,
  cartella     TEXT NOT NULL UNIQUE,
  data_inizio  TEXT,
  data_fine    TEXT,
  visibile     INTEGER NOT NULL DEFAULT 1,
  creato_il    TEXT NOT NULL DEFAULT (datetime('now')),
  aggiornato_il TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lavori_clienti (
  lavoro_id INTEGER NOT NULL REFERENCES lavori(id) ON DELETE CASCADE,
  utente_id INTEGER NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
  PRIMARY KEY (lavoro_id, utente_id)
);

CREATE TABLE IF NOT EXISTS aggiornamenti (
  id        INTEGER PRIMARY KEY,
  lavoro_id INTEGER NOT NULL REFERENCES lavori(id) ON DELETE CASCADE,
  testo     TEXT NOT NULL,
  creato_il TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accessi_file (
  id        INTEGER PRIMARY KEY,
  lavoro_id INTEGER NOT NULL REFERENCES lavori(id) ON DELETE CASCADE,
  utente_id INTEGER REFERENCES utenti(id) ON DELETE SET NULL,
  file      TEXT NOT NULL,
  creato_il TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessioni (
  sid     TEXT PRIMARY KEY,
  dati    TEXT NOT NULL,
  scade   INTEGER NOT NULL
);
`);

module.exports = db;
