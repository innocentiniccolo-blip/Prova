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

-- Sicurezza cantiere: anagrafica delle imprese (riutilizzabile su più lavori)
CREATE TABLE IF NOT EXISTS imprese (
  id              INTEGER PRIMARY KEY,
  ragione_sociale TEXT NOT NULL,
  piva            TEXT,
  sede            TEXT,
  pec             TEXT,
  telefono        TEXT,
  autonomo        INTEGER NOT NULL DEFAULT 0,
  nota            TEXT,
  creato_il       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Documenti dell'impresa: visura camerale, DURC, patente a crediti, altro
CREATE TABLE IF NOT EXISTS documenti_impresa (
  id          INTEGER PRIMARY KEY,
  impresa_id  INTEGER NOT NULL REFERENCES imprese(id) ON DELETE CASCADE,
  tipo        TEXT NOT NULL CHECK (tipo IN ('visura','durc','patente','altro')),
  descrizione TEXT,
  file        TEXT,
  rilascio    TEXT,
  scadenza    TEXT,
  numero      TEXT,
  crediti     INTEGER,
  caricato_il TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Imprese presenti in un cantiere
CREATE TABLE IF NOT EXISTS lavori_imprese (
  lavoro_id  INTEGER NOT NULL REFERENCES lavori(id) ON DELETE CASCADE,
  impresa_id INTEGER NOT NULL REFERENCES imprese(id) ON DELETE CASCADE,
  ruolo      TEXT,
  visibile   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (lavoro_id, impresa_id)
);

-- Sicurezza cantiere: verbali (sopralluoghi CSE, riunioni di coordinamento, ecc.)
CREATE TABLE IF NOT EXISTS verbali_cantiere (
  id          INTEGER PRIMARY KEY,
  lavoro_id   INTEGER NOT NULL REFERENCES lavori(id) ON DELETE CASCADE,
  data        TEXT NOT NULL,
  tipo        TEXT NOT NULL,
  note        TEXT,
  file        TEXT,
  visibile    INTEGER NOT NULL DEFAULT 1,
  creato_il   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessioni (
  sid     TEXT PRIMARY KEY,
  dati    TEXT NOT NULL,
  scade   INTEGER NOT NULL
);
`);

// Migrazioni leggere per i database già esistenti
const colonne = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
if (!colonne('lavori').includes('sicurezza')) db.exec('ALTER TABLE lavori ADD COLUMN sicurezza INTEGER NOT NULL DEFAULT 0');
if (!colonne('utenti').includes('informativa_il')) db.exec('ALTER TABLE utenti ADD COLUMN informativa_il TEXT');
// Ruoli sul lavoro (proprietario, agenzia, impresa) e visibilità delle pratiche per ruolo
if (!colonne('lavori_clienti').includes('ruolo')) db.exec("ALTER TABLE lavori_clienti ADD COLUMN ruolo TEXT NOT NULL DEFAULT 'proprietario'");
if (!colonne('lavori_clienti').includes('consenso_il')) db.exec('ALTER TABLE lavori_clienti ADD COLUMN consenso_il TEXT');
if (!colonne('pratiche').includes('visibile_agenzia')) db.exec('ALTER TABLE pratiche ADD COLUMN visibile_agenzia INTEGER NOT NULL DEFAULT 0');
if (!colonne('pratiche').includes('scartata')) db.exec('ALTER TABLE pratiche ADD COLUMN scartata INTEGER NOT NULL DEFAULT 0');
if (!colonne('pratiche').includes('visibile_impresa')) db.exec('ALTER TABLE pratiche ADD COLUMN visibile_impresa INTEGER NOT NULL DEFAULT 0');
// Aziende clienti (agenzie immobiliari, imprese) con più persone che accedono
db.exec(`CREATE TABLE IF NOT EXISTS aziende (
  id        INTEGER PRIMARY KEY,
  nome      TEXT NOT NULL,
  tipo      TEXT NOT NULL DEFAULT 'agenzia' CHECK (tipo IN ('agenzia','impresa')),
  piva      TEXT,
  email     TEXT,
  telefono  TEXT,
  creato_il TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS lavori_aziende (
  lavoro_id   INTEGER NOT NULL REFERENCES lavori(id) ON DELETE CASCADE,
  azienda_id  INTEGER NOT NULL REFERENCES aziende(id) ON DELETE CASCADE,
  ruolo       TEXT NOT NULL DEFAULT 'agenzia',
  consenso_il TEXT,
  PRIMARY KEY (lavoro_id, azienda_id)
);`);
if (!colonne('utenti').includes('azienda_id')) db.exec('ALTER TABLE utenti ADD COLUMN azienda_id INTEGER REFERENCES aziende(id) ON DELETE SET NULL');
// Scheda immobile (per agenzie e proprietari): conformità e APE
if (!colonne('lavori').includes('scheda')) db.exec('ALTER TABLE lavori ADD COLUMN scheda TEXT');
// Tappe delle pratiche lette dalle ricevute: integrazioni, inizio e fine lavori (la presentazione resta nella pratica)
db.exec(`CREATE TABLE IF NOT EXISTS pratiche_tappe (
  id         INTEGER PRIMARY KEY,
  pratica_id INTEGER NOT NULL REFERENCES pratiche(id) ON DELETE CASCADE,
  fase       TEXT NOT NULL CHECK (fase IN ('integrazione','inizio','fine')),
  data       TEXT,
  protocollo TEXT,
  file       TEXT,
  creato_il  TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// Migrazioni da fare una volta sola
db.exec('CREATE TABLE IF NOT EXISTS migrazioni (nome TEXT PRIMARY KEY, il TEXT NOT NULL DEFAULT (datetime(\'now\')))');
function unaVolta(nome, fn) {
  if (db.prepare('SELECT 1 FROM migrazioni WHERE nome = ?').get(nome)) return;
  fn();
  db.prepare('INSERT INTO migrazioni (nome) VALUES (?)').run(nome);
}
// Integrazioni confermate prima che esistessero le tappe: diventano tappe
unaVolta('tappe-da-integrazioni', () => db.exec(`INSERT INTO pratiche_tappe (pratica_id, fase, data, protocollo, file)
  SELECT ps.pratica_id, 'integrazione', ps.data, ps.protocollo, ps.file FROM proposte_stato ps
  WHERE ps.stato = 'Integrazione presentata' AND ps.stato_proposta = 'applicata'
    AND NOT EXISTS (SELECT 1 FROM pratiche_tappe t WHERE t.pratica_id = ps.pratica_id AND t.fase = 'integrazione'
      AND COALESCE(t.data, '') = COALESCE(ps.data, '') AND COALESCE(t.protocollo, '') = COALESCE(ps.protocollo, ''))`));
// Versione delle regole con cui è stato letto ogni file: con regole nuove si rileggono le ricevute
if (!colonne('file_letti').includes('regole')) db.exec('ALTER TABLE file_letti ADD COLUMN regole INTEGER NOT NULL DEFAULT 0');
// Visure e planimetrie catastali lette in automatico (src/visure.js)
db.exec(`CREATE TABLE IF NOT EXISTS visure_auto (
  pratica_id INTEGER NOT NULL REFERENCES pratiche(id) ON DELETE CASCADE,
  percorso   TEXT NOT NULL,
  dimensione INTEGER NOT NULL,
  modificato INTEGER NOT NULL,
  tipo       TEXT,
  storica    INTEGER NOT NULL DEFAULT 0,
  unita      TEXT,
  data       TEXT,
  testo_doc  TEXT,
  esito      TEXT NOT NULL DEFAULT 'privata',
  motivo     TEXT,
  escluso    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pratica_id, percorso)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS notule (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  anno         INTEGER NOT NULL,
  numero       INTEGER NOT NULL,
  lavoro_id    INTEGER REFERENCES lavori(id) ON DELETE SET NULL,
  dest_nome    TEXT NOT NULL DEFAULT '',
  dest_indirizzo TEXT NOT NULL DEFAULT '',
  dest_cf      TEXT NOT NULL DEFAULT '',
  dest_email   TEXT NOT NULL DEFAULT '',
  oggetto      TEXT NOT NULL DEFAULT '',
  data         TEXT NOT NULL,
  voci         TEXT NOT NULL DEFAULT '[]',
  spese        TEXT NOT NULL DEFAULT '[]',
  cassa_pct    REAL NOT NULL DEFAULT 5,
  iva_pct      REAL NOT NULL DEFAULT 22,
  sostituto    INTEGER NOT NULL DEFAULT 0,
  note         TEXT NOT NULL DEFAULT '',
  stato        TEXT NOT NULL DEFAULT 'bozza',
  inviata_il   TEXT,
  pagata_il    TEXT,
  creata_il    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (anno, numero)
)`);

module.exports = db;
