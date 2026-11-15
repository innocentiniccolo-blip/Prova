'use strict';
/**
 * Documenti richiesti al cliente: lo studio apre una richiesta ("Carta d'identità", "Atto di provenienza"…),
 * il cliente carica i file dall'area riservata. I file finiscono nella cartella del lavoro, in
 * "Documenti dal cliente/<richiesta>/", così arrivano nell'archivio insieme al resto.
 * I file dei clienti sono contenuto non fidato: tipi ammessi limitati, controllo del contenuto,
 * limiti di dimensione e di spazio, nessuna lettura automatica.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const db = require('./db');
const archivio = require('./archivio');

const CARTELLA = archivio.CARTELLA_CLIENTE;
const MB = 1024 * 1024;
const LIMITI = { fileMb: 25, filePerInvio: 8, filePerRichiesta: 40, lavoroMb: 500 };

db.exec(`
CREATE TABLE IF NOT EXISTS richieste_documenti (
  id          INTEGER PRIMARY KEY,
  lavoro_id   INTEGER NOT NULL REFERENCES lavori(id) ON DELETE CASCADE,
  titolo      TEXT NOT NULL,
  descrizione TEXT,
  cartella    TEXT NOT NULL,
  stato       TEXT NOT NULL DEFAULT 'aperta' CHECK (stato IN ('aperta','inviata','completa')),
  creato_il   TEXT NOT NULL DEFAULT (datetime('now')),
  inviato_il  TEXT
);
CREATE TABLE IF NOT EXISTS file_richiesti (
  id           INTEGER PRIMARY KEY,
  richiesta_id INTEGER NOT NULL REFERENCES richieste_documenti(id) ON DELETE CASCADE,
  nome         TEXT NOT NULL,
  dimensione   INTEGER NOT NULL,
  utente_id    INTEGER REFERENCES utenti(id) ON DELETE SET NULL,
  caricato_il  TEXT NOT NULL DEFAULT (datetime('now'))
);`);

const Q = {
  perLavoro: db.prepare('SELECT * FROM richieste_documenti WHERE lavoro_id = ? ORDER BY stato = \'completa\', id DESC'),
  perId: db.prepare('SELECT * FROM richieste_documenti WHERE id = ? AND lavoro_id = ?'),
  inserisci: db.prepare('INSERT INTO richieste_documenti (lavoro_id, titolo, descrizione, cartella) VALUES (?, ?, ?, ?)'),
  stato: db.prepare("UPDATE richieste_documenti SET stato = ?, inviato_il = CASE WHEN ? = 'inviata' THEN datetime('now') ELSE inviato_il END WHERE id = ?"),
  elimina: db.prepare('DELETE FROM richieste_documenti WHERE id = ? AND lavoro_id = ?'),
  cartelle: db.prepare('SELECT cartella FROM richieste_documenti WHERE lavoro_id = ?'),
  file: db.prepare('SELECT f.*, u.nome AS caricato_da FROM file_richiesti f LEFT JOIN utenti u ON u.id = f.utente_id WHERE richiesta_id = ? ORDER BY f.id'),
  fileId: db.prepare('SELECT * FROM file_richiesti WHERE id = ? AND richiesta_id = ?'),
  aggiungiFile: db.prepare('INSERT INTO file_richiesti (richiesta_id, nome, dimensione, utente_id) VALUES (?, ?, ?, ?)'),
  togliFile: db.prepare('DELETE FROM file_richiesti WHERE id = ?'),
  contaFile: db.prepare('SELECT COUNT(*) AS n FROM file_richiesti WHERE richiesta_id = ?'),
  spazioLavoro: db.prepare(`SELECT COALESCE(SUM(f.dimensione), 0) AS b FROM file_richiesti f
    JOIN richieste_documenti r ON r.id = f.richiesta_id WHERE r.lavoro_id = ?`),
  daControllare: db.prepare(`SELECT r.*, l.codice, l.titolo AS lavoro_titolo,
      (SELECT COUNT(*) FROM file_richiesti f WHERE f.richiesta_id = r.id) AS n_file
    FROM richieste_documenti r JOIN lavori l ON l.id = r.lavoro_id WHERE r.stato = 'inviata' ORDER BY r.inviato_il DESC`),
};

// Tipi ammessi e "firma" con cui deve iniziare il file (null = nessuna firma affidabile)
const zip = (b) => b[0] === 0x50 && b[1] === 0x4b;
const ole = (b) => b.readUInt32BE(0) === 0xd0cf11e0;
const TIPI = {
  '.pdf': (b) => b.subarray(0, 1024).includes('%PDF-'),
  '.jpg': (b) => b[0] === 0xff && b[1] === 0xd8, '.jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  '.png': (b) => b.readUInt32BE(0) === 0x89504e47,
  '.heic': (b) => b.toString('latin1', 4, 8) === 'ftyp', '.heif': (b) => b.toString('latin1', 4, 8) === 'ftyp',
  '.webp': (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  '.tif': (b) => ['II*\0', 'MM\0*'].includes(b.toString('latin1', 0, 4)), '.tiff': (b) => ['II*\0', 'MM\0*'].includes(b.toString('latin1', 0, 4)),
  '.docx': zip, '.xlsx': zip, '.odt': zip, '.ods': zip,
  '.doc': ole, '.xls': ole,
  '.p7m': null,
};
const ESTENSIONI = Object.keys(TIPI);

/** Controlla estensione e contenuto di un file caricato. Restituisce null se va bene, altrimenti il motivo. */
async function motivoRifiuto(tmpPath, nome) {
  const ext = path.extname(nome || '').toLowerCase();
  if (!(ext in TIPI)) return 'tipo di file non ammesso';
  const fh = await fsp.open(tmpPath, 'r');
  try {
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(buf, 0, 1024, 0);
    if (bytesRead < 12) return 'file vuoto o danneggiato';
    const firma = TIPI[ext];
    if (firma && !firma(buf.subarray(0, bytesRead))) return 'il contenuto non corrisponde al tipo di file';
  } finally { await fh.close(); }
  return null;
}

function cartellaRichiesta(lavoro, r) {
  const base = archivio.cartellaLavoro(lavoro);
  return base ? archivio.risolviDentro(base, path.join(CARTELLA, r.cartella)) : null;
}

function crea(lavoro, titolo, descrizione) {
  const baseNome = archivio.nomeSicuro(titolo) || 'Documenti';
  const usate = new Set(Q.cartelle.all(lavoro.id).map((x) => x.cartella.toLowerCase()));
  let cartella = baseNome.slice(0, 80).trim();
  for (let i = 2; usate.has(cartella.toLowerCase()); i++) cartella = `${baseNome.slice(0, 80).trim()} (${i})`;
  return Number(Q.inserisci.run(lavoro.id, titolo, descrizione || null, cartella).lastInsertRowid);
}

function elenco(lavoroId) {
  return Q.perLavoro.all(lavoroId).map((r) => ({ ...r, file: Q.file.all(r.id) }));
}

/**
 * Salva i file caricati dal cliente. Restituisce { salvati: [nomi], rifiutati: [{ nome, motivo }] }.
 * I file temporanei vengono rimossi da chi chiama.
 */
async function ricevi(lavoro, richiesta, files, utenteId) {
  const esito = { salvati: [], rifiutati: [] };
  const dir = cartellaRichiesta(lavoro, richiesta);
  if (!dir) throw new Error('Cartella del lavoro non disponibile');
  let nFile = Q.contaFile.get(richiesta.id).n;
  let spazio = Q.spazioLavoro.get(lavoro.id).b;
  for (const f of files) {
    const originale = Buffer.from(f.originalname, 'latin1').toString('utf8');
    const nome = archivio.nomeSicuro(originale);
    let motivo = !nome ? 'nome non valido' : await motivoRifiuto(f.path, nome);
    if (!motivo && nFile >= LIMITI.filePerRichiesta) motivo = `massimo ${LIMITI.filePerRichiesta} file per richiesta`;
    if (!motivo && spazio + f.size > LIMITI.lavoroMb * MB) motivo = 'spazio disponibile esaurito: contatta lo studio';
    if (motivo) { esito.rifiutati.push({ nome: nome || 'file', motivo }); continue; }
    await fsp.mkdir(dir, { recursive: true });
    const ext = path.extname(nome);
    const radice = nome.slice(0, nome.length - ext.length);
    let finale = nome;
    for (let i = 2; fs.existsSync(path.join(dir, finale)); i++) finale = `${radice} (${i})${ext}`;
    await fsp.copyFile(f.path, path.join(dir, finale), fs.constants.COPYFILE_EXCL);
    Q.aggiungiFile.run(richiesta.id, finale, f.size, utenteId);
    nFile++; spazio += f.size;
    esito.salvati.push(finale);
  }
  if (esito.salvati.length) Q.stato.run('inviata', 'inviata', richiesta.id);
  return esito;
}

function percorsoFile(lavoro, richiesta, file) {
  const dir = cartellaRichiesta(lavoro, richiesta);
  const abs = dir && file ? archivio.risolviDentro(dir, file.nome) : null;
  return abs && abs !== dir && fs.existsSync(abs) ? abs : null;
}

async function eliminaFile(lavoro, richiesta, file) {
  const abs = percorsoFile(lavoro, richiesta, file);
  if (abs) await fsp.rm(abs, { force: true });
  Q.togliFile.run(file.id);
  if (Q.contaFile.get(richiesta.id).n === 0 && richiesta.stato === 'inviata') Q.stato.run('aperta', 'aperta', richiesta.id);
}

// Massimo 40 invii all'ora per utente (ogni invio può contenere più file)
const invii = new Map();
function troppiInvii(utenteId) {
  const ora = Date.now();
  const recenti = (invii.get(utenteId) || []).filter((t) => ora - t < 60 * 60 * 1000);
  if (recenti.length >= 40) { invii.set(utenteId, recenti); return true; }
  recenti.push(ora); invii.set(utenteId, recenti);
  return false;
}

module.exports = { troppiInvii, azzeraInvii: () => invii.clear(), Q, LIMITI, ESTENSIONI, CARTELLA, crea, elenco, ricevi, percorsoFile, eliminaFile, motivoRifiuto };
