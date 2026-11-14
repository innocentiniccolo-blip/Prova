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

-- Una pratica = una sottocartella del lavoro sul NAS (es. "CILA", "Accesso atti")
CREATE TABLE IF NOT EXISTS pratiche (
  id           INTEGER PRIMARY KEY,
  lavoro_id    INTEGER NOT NULL REFERENCES lavori(id) ON DELETE CASCADE,
  cartella     TEXT NOT NULL,
  stato        TEXT NOT NULL,
  data         TEXT,
  protocollo   TEXT,
  nota         TEXT,
  visibile     INTEGER NOT NULL DEFAULT 0,
  ordine       INTEGER NOT NULL DEFAULT 100,
  aggiornato_il TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (lavoro_id, cartella)
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

-- Link monouso per impostare o reimpostare la password (si salva solo l'impronta del token)
CREATE TABLE IF NOT EXISTS link_password (
  id         INTEGER PRIMARY KEY,
  utente_id  INTEGER NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
  impronta   TEXT NOT NULL UNIQUE,
  scade      INTEGER NOT NULL,
  usato      INTEGER NOT NULL DEFAULT 0
);

-- Lavori trovati sul NAS grazie al file _cliente.txt, in attesa di conferma
CREATE TABLE IF NOT EXISTS proposte_lavori (
  id        INTEGER PRIMARY KEY,
  cartella  TEXT NOT NULL UNIQUE,
  nome      TEXT NOT NULL,
  email     TEXT NOT NULL,
  telefono  TEXT,
  stato     TEXT NOT NULL DEFAULT 'nuova' CHECK (stato IN ('nuova','confermata','scartata')),
  creato_il TEXT NOT NULL DEFAULT (datetime('now'))
);

-- File delle pratiche già esaminati dalla lettura automatica delle ricevute
CREATE TABLE IF NOT EXISTS file_letti (
  pratica_id INTEGER NOT NULL REFERENCES pratiche(id) ON DELETE CASCADE,
  percorso   TEXT NOT NULL,
  modificato INTEGER NOT NULL,
  PRIMARY KEY (pratica_id, percorso)
);

-- Aggiornamenti di stato proposti leggendo una ricevuta, in attesa di conferma
CREATE TABLE IF NOT EXISTS proposte_stato (
  id         INTEGER PRIMARY KEY,
  pratica_id INTEGER NOT NULL REFERENCES pratiche(id) ON DELETE CASCADE,
  file       TEXT NOT NULL,
  tipo       TEXT NOT NULL,
  stato      TEXT NOT NULL,
  data       TEXT,
  protocollo TEXT,
  stato_proposta TEXT NOT NULL DEFAULT 'nuova' CHECK (stato_proposta IN ('nuova','applicata','scartata')),
  creato_il  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessioni (
  sid     TEXT PRIMARY KEY,
  dati    TEXT NOT NULL,
  scade   INTEGER NOT NULL
);
`);

module.exports = db;
