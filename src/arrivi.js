'use strict';
/**
 * Documenti in arrivo dalle imprese (link di caricamento o risposta via email al promemoria).
 *
 * Ogni file è contenuto non fidato:
 *  - solo PDF, JPG, PNG, controllati anche dal contenuto, al massimo 10 MB;
 *  - controllo antivirus (ClamAV) se attivo: i file infetti vengono scartati subito;
 *  - finiscono in "Da controllare": diventano documenti dell'impresa solo quando lo studio li approva.
 * I file stanno nella cartella dati del server (dati/arrivi/<impresa>), non su Google Drive.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');
const db = require('./db');
const imprese = require('./imprese');
const antivirus = require('./antivirus');
const { motivoRifiuto } = require('./richieste');
const { nomeSicuro } = require('./archivio');

const MB = 1024 * 1024;
const LIMITI = { fileMb: 10, filePerInvio: 5, inAttesaPerImpresa: 30, giorniLink: 14 };
const ESTENSIONI = ['.pdf', '.jpg', '.jpeg', '.png'];
const dirArrivi = path.join(config.datiDir, 'arrivi');
fs.mkdirSync(dirArrivi, { recursive: true });

db.exec(`
CREATE TABLE IF NOT EXISTS link_caricamento (
  id         INTEGER PRIMARY KEY,
  impresa_id INTEGER NOT NULL REFERENCES imprese(id) ON DELETE CASCADE,
  impronta   TEXT NOT NULL UNIQUE,
  scade      INTEGER NOT NULL,
  creato_il  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS arrivi_imprese (
  id          INTEGER PRIMARY KEY,
  impresa_id  INTEGER NOT NULL REFERENCES imprese(id) ON DELETE CASCADE,
  origine     TEXT NOT NULL CHECK (origine IN ('link','email')),
  mittente    TEXT,
  nome        TEXT NOT NULL,
  file        TEXT,
  dimensione  INTEGER NOT NULL DEFAULT 0,
  antivirus   TEXT NOT NULL,
  antivirus_dettaglio TEXT,
  letto       TEXT,
  stato       TEXT NOT NULL DEFAULT 'da-controllare' CHECK (stato IN ('da-controllare','approvato','scartato')),
  ricevuto_il TEXT NOT NULL DEFAULT (datetime('now')),
  chiuso_il   TEXT
);`);

const Q = {
  inserisciLink: db.prepare('INSERT INTO link_caricamento (impresa_id, impronta, scade) VALUES (?, ?, ?)'),
  link: db.prepare('SELECT * FROM link_caricamento WHERE impronta = ? AND scade > ?'),
  pulisciLink: db.prepare('DELETE FROM link_caricamento WHERE scade < ?'),
  inserisci: db.prepare(`INSERT INTO arrivi_imprese (impresa_id, origine, mittente, nome, dimensione, antivirus, antivirus_dettaglio, letto)
    VALUES (:impresa_id, :origine, :mittente, :nome, :dimensione, :antivirus, :antivirus_dettaglio, :letto)`),
  impostaFile: db.prepare('UPDATE arrivi_imprese SET file = ? WHERE id = ?'),
  perId: db.prepare('SELECT * FROM arrivi_imprese WHERE id = ? AND impresa_id = ?'),
  inAttesa: db.prepare("SELECT * FROM arrivi_imprese WHERE impresa_id = ? AND stato = 'da-controllare' ORDER BY id"),
  contaInAttesa: db.prepare("SELECT COUNT(*) AS n FROM arrivi_imprese WHERE impresa_id = ? AND stato = 'da-controllare'"),
  tuttiInAttesa: db.prepare(`SELECT i.id AS impresa_id, i.ragione_sociale, COUNT(*) AS n, MAX(a.ricevuto_il) AS ultimo
    FROM arrivi_imprese a JOIN imprese i ON i.id = a.impresa_id WHERE a.stato = 'da-controllare'
    GROUP BY i.id ORDER BY ultimo DESC`),
  chiudi: db.prepare("UPDATE arrivi_imprese SET stato = ?, file = NULL, chiuso_il = datetime('now') WHERE id = ?"),
  pulisciVecchi: db.prepare("DELETE FROM arrivi_imprese WHERE stato != 'da-controllare' AND chiuso_il < datetime('now', '-12 months')"),
};

const impronta = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// ---------- Link di caricamento ----------
/** Crea un link personale per l'impresa (valido 14 giorni) e restituisce l'indirizzo completo, o '' se manca URL_PUBBLICO. */
function creaLink(impresaId) {
  Q.pulisciLink.run(Date.now());
  const token = crypto.randomBytes(32).toString('base64url');
  Q.inserisciLink.run(impresaId, impronta(token), Date.now() + LIMITI.giorniLink * 24 * 60 * 60 * 1000);
  const base = config.urlPubblico || (config.produzione ? '' : `http://localhost:${config.port}`);
  return base ? `${base}/carica/${token}` : '';
}

/** Restituisce l'impresa del link se il token è valido e non scaduto, altrimenti null. */
function verificaLink(token) {
  if (!/^[A-Za-z0-9_-]{30,100}$/.test(String(token || ''))) return null;
  const l = Q.link.get(impronta(token), Date.now());
  const impresa = l && imprese.Q.perId.get(l.impresa_id);
  return impresa ? { link: l, impresa } : null;
}

// ---------- Codice di riferimento nell'oggetto delle email ----------
// Es. "[Rif. IMP-12-a3f9c1]": l'ultima parte è una firma, così nessuno può inventarsi il codice di un'altra impresa
const firma = (id) => crypto.createHmac('sha256', config.sessionSecret).update(`impresa:${id}`).digest('hex').slice(0, 6);
const riferimento = (impresaId) => `[Rif. IMP-${impresaId}-${firma(impresaId)}]`;
function leggiRiferimento(oggetto) {
  const m = String(oggetto || '').match(/\bIMP-(\d{1,9})-([0-9a-f]{6})\b/i);
  if (!m) return null;
  const id = Number(m[1]);
  return crypto.timingSafeEqual(Buffer.from(firma(id)), Buffer.from(m[2].toLowerCase())) ? id : null;
}

// ---------- Ricezione ----------
/** Legge dal PDF il tipo di documento e le date (stesse regole della cartella Sicurezza su Drive). */
async function leggi(percorso, nome) {
  if (path.extname(nome).toLowerCase() !== '.pdf') return { tipo: 'altro' };
  try {
    const { testoDocumento } = require('./ocr');
    const { leggiDocumento } = require('./sicurezzaDrive');
    const d = leggiDocumento(nome, await testoDocumento(percorso));
    return { tipo: d.tipo, rilascio: d.rilascio || null, scadenza: d.scadenza || null, numero: d.numero || null, crediti: d.crediti ?? null };
  } catch { return { tipo: 'altro' }; }
}

/**
 * Riceve un file per l'impresa. f = { percorso, nome, dimensione }.
 * Restituisce { ok: true, id } oppure { ok: false, motivo }.
 */
async function ricevi(impresaId, f, { origine, mittente = null }) {
  const nome = nomeSicuro(f.nome);
  const ext = path.extname(nome || '').toLowerCase();
  if (!nome) return { ok: false, motivo: 'nome non valido' };
  if (!ESTENSIONI.includes(ext)) return { ok: false, motivo: 'sono ammessi solo PDF, JPG e PNG' };
  if (f.dimensione > LIMITI.fileMb * MB) return { ok: false, motivo: `file oltre ${LIMITI.fileMb} MB` };
  const rifiuto = await motivoRifiuto(f.percorso, nome);
  if (rifiuto) return { ok: false, motivo: rifiuto };
  if (Q.contaInAttesa.get(impresaId).n >= LIMITI.inAttesaPerImpresa) return { ok: false, motivo: 'troppi documenti in attesa: contatta lo studio' };
  const av = await antivirus.controlla(f.percorso);
  if (av.esito === 'infetto') {
    console.warn(`Antivirus: scartato «${nome}» per l'impresa ${impresaId} (${av.dettaglio})`);
    return { ok: false, motivo: 'il file non ha superato il controllo antivirus', infetto: true, dettaglio: av.dettaglio };
  }
  const letto = await leggi(f.percorso, nome);
  const id = Number(Q.inserisci.run({
    impresa_id: impresaId, origine, mittente, nome, dimensione: f.dimensione,
    antivirus: av.esito, antivirus_dettaglio: av.dettaglio, letto: JSON.stringify(letto),
  }).lastInsertRowid);
  const dir = path.join(dirArrivi, String(impresaId));
  await fsp.mkdir(dir, { recursive: true });
  const file = `${id}-${nome}`;
  await fsp.copyFile(f.percorso, path.join(dir, file));
  Q.impostaFile.run(file, id);
  return { ok: true, id };
}

function percorso(arrivo) {
  if (!arrivo || !arrivo.file) return null;
  const abs = path.join(dirArrivi, String(arrivo.impresa_id), path.basename(arrivo.file));
  return fs.existsSync(abs) ? abs : null;
}

/** Elenco dei file da controllare di un'impresa, con i dati letti in automatico. */
function inAttesa(impresaId) {
  return Q.inAttesa.all(impresaId).map((a) => ({ ...a, letto: JSON.parse(a.letto || '{}') }));
}

/** Approva: registra il file come documento dell'impresa con i dati confermati dallo studio. */
async function approva(arrivo, dati) {
  const abs = percorso(arrivo);
  if (!abs || arrivo.stato !== 'da-controllare') return false;
  await imprese.salvaDocumento(arrivo.impresa_id, dati, abs, arrivo.nome);
  await fsp.rm(abs, { force: true });
  Q.chiudi.run('approvato', arrivo.id);
  return true;
}

async function scarta(arrivo) {
  const abs = percorso(arrivo);
  if (abs) await fsp.rm(abs, { force: true });
  Q.chiudi.run('scartato', arrivo.id);
}

// Massimo 20 invii all'ora per indirizzo IP dalla pagina pubblica di caricamento
const invii = new Map();
function troppiInvii(chiave) {
  const ora = Date.now();
  const recenti = (invii.get(chiave) || []).filter((t) => ora - t < 60 * 60 * 1000);
  if (recenti.length >= 20) { invii.set(chiave, recenti); return true; }
  recenti.push(ora); invii.set(chiave, recenti);
  return false;
}

module.exports = {
  Q, LIMITI, ESTENSIONI, creaLink, verificaLink, riferimento, leggiRiferimento,
  ricevi, percorso, inAttesa, approva, scarta, troppiInvii, azzeraInvii: () => invii.clear(),
  pulisci: () => Q.pulisciVecchi.run(),
};
