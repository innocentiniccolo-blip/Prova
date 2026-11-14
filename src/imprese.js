'use strict';
/**
 * Sicurezza cantiere: imprese che lavorano nei cantieri e i loro documenti
 * (visura camerale, DURC, patente a crediti). I file stanno nella cartella dati
 * del server, non sul NAS, perché la stessa impresa può lavorare in più cantieri.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');
const db = require('./db');
const { nomeSicuro } = require('./archivio');

const TIPI = {
  visura: 'Visura camerale',
  durc: 'DURC',
  patente: 'Patente a crediti',
  altro: 'Altro documento',
};
const PRINCIPALI = ['visura', 'durc', 'patente'];
const GIORNI_PREAVVISO = 15;
const CREDITI_MINIMI = 15; // sotto questa soglia l'impresa non può operare in cantiere

const dirImprese = path.join(config.datiDir, 'imprese');
fs.mkdirSync(dirImprese, { recursive: true });

const Q = {
  tutte: db.prepare(`
    SELECT i.*, COUNT(DISTINCT li.lavoro_id) AS n_lavori FROM imprese i
    LEFT JOIN lavori_imprese li ON li.impresa_id = i.id
    GROUP BY i.id ORDER BY i.ragione_sociale COLLATE NOCASE`),
  perId: db.prepare('SELECT * FROM imprese WHERE id = ?'),
  inserisci: db.prepare(`INSERT INTO imprese (ragione_sociale, piva, sede, pec, telefono, autonomo, nota)
    VALUES (:ragione_sociale, :piva, :sede, :pec, :telefono, :autonomo, :nota)`),
  aggiorna: db.prepare(`UPDATE imprese SET ragione_sociale = :ragione_sociale, piva = :piva, sede = :sede,
    pec = :pec, telefono = :telefono, autonomo = :autonomo, nota = :nota WHERE id = :id`),
  elimina: db.prepare('DELETE FROM imprese WHERE id = ?'),
  documenti: db.prepare(`SELECT * FROM documenti_impresa WHERE impresa_id = ?
    ORDER BY COALESCE(rilascio, substr(caricato_il, 1, 10)) DESC, id DESC`),
  documento: db.prepare('SELECT * FROM documenti_impresa WHERE id = ? AND impresa_id = ?'),
  inserisciDoc: db.prepare(`INSERT INTO documenti_impresa (impresa_id, tipo, descrizione, rilascio, scadenza, numero, crediti)
    VALUES (:impresa_id, :tipo, :descrizione, :rilascio, :scadenza, :numero, :crediti)`),
  impostaFile: db.prepare('UPDATE documenti_impresa SET file = ? WHERE id = ?'),
  eliminaDoc: db.prepare('DELETE FROM documenti_impresa WHERE id = ? AND impresa_id = ?'),
  lavoriImpresa: db.prepare(`SELECT l.id, l.codice, l.titolo, l.stato, li.ruolo FROM lavori l
    JOIN lavori_imprese li ON li.lavoro_id = l.id WHERE li.impresa_id = ? ORDER BY l.codice DESC`),
  delLavoro: db.prepare(`SELECT i.*, li.ruolo, li.visibile FROM imprese i
    JOIN lavori_imprese li ON li.impresa_id = i.id WHERE li.lavoro_id = ? ORDER BY i.ragione_sociale COLLATE NOCASE`),
  collega: db.prepare(`INSERT INTO lavori_imprese (lavoro_id, impresa_id, ruolo, visibile) VALUES (?, ?, ?, ?)
    ON CONFLICT (lavoro_id, impresa_id) DO UPDATE SET ruolo = excluded.ruolo, visibile = excluded.visibile`),
  scollega: db.prepare('DELETE FROM lavori_imprese WHERE lavoro_id = ? AND impresa_id = ?'),
  collegamento: db.prepare('SELECT * FROM lavori_imprese WHERE lavoro_id = ? AND impresa_id = ?'),
  inCantieriAttivi: db.prepare(`SELECT DISTINCT i.* FROM imprese i
    JOIN lavori_imprese li ON li.impresa_id = i.id JOIN lavori l ON l.id = li.lavoro_id
    WHERE l.stato NOT IN ('Completato', 'Sospeso')`),
};

function oggi() {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}
function giorniA(dataIso) {
  const [a, m, g] = dataIso.split('-').map(Number);
  return Math.round((Date.UTC(a, m - 1, g) - oggi()) / 86400000);
}
function aggiungi(dataIso, { giorni = 0, mesi = 0 }) {
  const [a, m, g] = dataIso.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 + mesi, g + giorni));
  return d.toISOString().slice(0, 10);
}

/** Scadenza proposta quando non è indicata: DURC 120 giorni; visura da aggiornare dopo 6 mesi (prassi). */
function scadenzaPredefinita(tipo, rilascio) {
  if (!rilascio) return null;
  if (tipo === 'durc') return aggiungi(rilascio, { giorni: 120 });
  if (tipo === 'visura') return aggiungi(rilascio, { mesi: 6 });
  return null;
}

/** Stato di un documento: ok | in-scadenza | scaduto | insufficiente | mancante */
function statoDocumento(doc) {
  if (!doc) return { codice: 'mancante', testo: 'Mancante' };
  if (doc.tipo === 'patente' && doc.crediti != null && doc.crediti < CREDITI_MINIMI) {
    return { codice: 'insufficiente', testo: `${doc.crediti} crediti: sotto la soglia di ${CREDITI_MINIMI}` };
  }
  if (doc.scadenza) {
    const g = giorniA(doc.scadenza);
    if (g < 0) return { codice: 'scaduto', testo: doc.tipo === 'visura' ? 'Da aggiornare' : 'Scaduto' };
    if (g <= GIORNI_PREAVVISO) return { codice: 'in-scadenza', testo: g === 0 ? 'Scade oggi' : `Scade tra ${g} giorni` };
  }
  return { codice: 'ok', testo: doc.tipo === 'patente' && doc.crediti != null ? `${doc.crediti} crediti` : 'Valido' };
}

/** Per ogni tipo principale, il documento più recente con il suo stato. */
function riepilogo(impresaId) {
  const docs = Q.documenti.all(impresaId);
  const out = {};
  for (const t of PRINCIPALI) {
    const doc = docs.find((d) => d.tipo === t) || null;
    out[t] = { doc, stato: statoDocumento(doc) };
  }
  out.altri = docs.filter((d) => d.tipo === 'altro');
  out.problemi = PRINCIPALI.filter((t) => out[t].stato.codice !== 'ok').length;
  return out;
}

function impreseDelLavoro(lavoroId, { soloVisibili = false } = {}) {
  return Q.delLavoro.all(lavoroId)
    .filter((i) => !soloVisibili || i.visibile)
    .map((i) => ({ ...i, riepilogo: riepilogo(i.id) }));
}

/** Documenti scaduti o in scadenza delle imprese nei cantieri attivi (per il cruscotto). */
function avvisiScadenze() {
  const avvisi = [];
  for (const i of Q.inCantieriAttivi.all()) {
    const r = riepilogo(i.id);
    for (const t of PRINCIPALI) {
      if (r[t].stato.codice !== 'ok') avvisi.push({ impresa: i, tipo: TIPI[t], stato: r[t].stato });
    }
  }
  return avvisi;
}

function percorsoFile(doc) {
  if (!doc || !doc.file) return null;
  const abs = path.join(dirImprese, String(doc.impresa_id), doc.file);
  return abs.startsWith(dirImprese + path.sep) && fs.existsSync(abs) ? abs : null;
}

async function salvaDocumento(impresaId, dati, tmp, nomeOriginale) {
  const tipo = TIPI[dati.tipo] ? dati.tipo : 'altro';
  const r = Q.inserisciDoc.run({
    impresa_id: impresaId,
    tipo,
    descrizione: dati.descrizione || null,
    rilascio: dati.rilascio || null,
    scadenza: dati.scadenza || scadenzaPredefinita(tipo, dati.rilascio),
    numero: dati.numero || null,
    crediti: tipo === 'patente' && Number.isInteger(dati.crediti) ? dati.crediti : null,
  });
  const id = Number(r.lastInsertRowid);
  if (tmp) {
    const nome = `${id}-${nomeSicuro(nomeOriginale) || 'documento'}`;
    const dir = path.join(dirImprese, String(impresaId));
    await fsp.mkdir(dir, { recursive: true });
    await fsp.copyFile(tmp, path.join(dir, nome));
    Q.impostaFile.run(nome, id);
  }
  return id;
}

async function eliminaDocumento(impresaId, docId) {
  const doc = Q.documento.get(docId, impresaId);
  if (!doc) return false;
  const abs = percorsoFile(doc);
  if (abs) await fsp.rm(abs, { force: true });
  Q.eliminaDoc.run(docId, impresaId);
  return true;
}

async function eliminaImpresa(id) {
  Q.elimina.run(id);
  await fsp.rm(path.join(dirImprese, String(id)), { recursive: true, force: true });
}

module.exports = {
  TIPI, PRINCIPALI, CREDITI_MINIMI, Q,
  scadenzaPredefinita, statoDocumento, riepilogo, impreseDelLavoro, avvisiScadenze,
  percorsoFile, salvaDocumento, eliminaDocumento, eliminaImpresa,
};
