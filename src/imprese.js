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
const dirImprese = path.join(config.datiDir, 'imprese');
fs.mkdirSync(dirImprese, { recursive: true });
const GIORNI_PREAVVISO = 15;
const CREDITI_MINIMI = 15; // sotto questa soglia l'impresa non può operare in cantiere

if (!db.prepare("SELECT 1 FROM pragma_table_info('imprese') WHERE name = 'email'").get()) db.exec('ALTER TABLE imprese ADD COLUMN email TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS promemoria_imprese (
  id         INTEGER PRIMARY KEY,
  impresa_id INTEGER NOT NULL REFERENCES imprese(id) ON DELETE CASCADE,
  tipo       TEXT NOT NULL,
  a          TEXT NOT NULL,
  inviato_il TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const Q = {
  tutte: db.prepare(`
    SELECT i.*, COUNT(DISTINCT li.lavoro_id) AS n_lavori FROM imprese i
    LEFT JOIN lavori_imprese li ON li.impresa_id = i.id
    GROUP BY i.id ORDER BY i.ragione_sociale COLLATE NOCASE`),
  perId: db.prepare('SELECT * FROM imprese WHERE id = ?'),
  inserisci: db.prepare(`INSERT INTO imprese (ragione_sociale, piva, sede, pec, email, telefono, autonomo, nota)
    VALUES (:ragione_sociale, :piva, :sede, :pec, :email, :telefono, :autonomo, :nota)`),
  aggiorna: db.prepare(`UPDATE imprese SET ragione_sociale = :ragione_sociale, piva = :piva, sede = :sede,
    pec = :pec, email = :email, telefono = :telefono, autonomo = :autonomo, nota = :nota WHERE id = :id`),
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
    WHERE l.sicurezza = 1 AND l.stato NOT IN ('Completato', 'Sospeso')`),
  impostaSicurezza: db.prepare('UPDATE lavori SET sicurezza = ? WHERE id = ?'),
  verbali: db.prepare('SELECT * FROM verbali_cantiere WHERE lavoro_id = ? ORDER BY data DESC, id DESC'),
  verbale: db.prepare('SELECT * FROM verbali_cantiere WHERE id = ? AND lavoro_id = ?'),
  inserisciVerbale: db.prepare(`INSERT INTO verbali_cantiere (lavoro_id, data, tipo, note, visibile)
    VALUES (:lavoro_id, :data, :tipo, :note, :visibile)`),
  fileVerbale: db.prepare('UPDATE verbali_cantiere SET file = ? WHERE id = ?'),
  visibilitaVerbale: db.prepare('UPDATE verbali_cantiere SET visibile = ? WHERE id = ? AND lavoro_id = ?'),
  eliminaVerbale: db.prepare('DELETE FROM verbali_cantiere WHERE id = ? AND lavoro_id = ?'),
  registraPromemoria: db.prepare('INSERT INTO promemoria_imprese (impresa_id, tipo, a) VALUES (?, ?, ?)'),
  ultimiPromemoria: db.prepare(`SELECT tipo, MAX(inviato_il) AS il FROM promemoria_imprese WHERE impresa_id = ? GROUP BY tipo`),
};

const TIPI_VERBALE = ['Sopralluogo del CSE', 'Riunione di coordinamento', 'Verifica idoneità imprese', 'Verbale di consegna lavori', 'Sospensione lavori', 'Altro'];
const dirVerbali = path.join(config.datiDir, 'verbali');
fs.mkdirSync(dirVerbali, { recursive: true });

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

// Avvisi nascosti dallo studio: tornano da soli se arriva un documento nuovo o cambia lo stato
db.exec(`CREATE TABLE IF NOT EXISTS avvisi_nascosti (
  impresa_id INTEGER NOT NULL REFERENCES imprese(id) ON DELETE CASCADE,
  tipo       TEXT NOT NULL,
  chiave     TEXT NOT NULL,
  PRIMARY KEY (impresa_id, tipo)
)`);
const QA = {
  nascosto: db.prepare('SELECT chiave FROM avvisi_nascosti WHERE impresa_id = ? AND tipo = ?'),
  nascondi: db.prepare(`INSERT INTO avvisi_nascosti (impresa_id, tipo, chiave) VALUES (?, ?, ?)
    ON CONFLICT (impresa_id, tipo) DO UPDATE SET chiave = excluded.chiave`),
};
const chiaveAvviso = (doc, stato) => `${doc ? doc.id : 0}:${stato.codice}`;

/** Documenti scaduti o in scadenza delle imprese nei cantieri attivi (per il cruscotto). */
function avvisiScadenze() {
  const avvisi = [];
  for (const i of Q.inCantieriAttivi.all()) {
    const r = riepilogo(i.id);
    for (const t of PRINCIPALI) {
      if (r[t].stato.codice === 'ok') continue;
      const chiave = chiaveAvviso(r[t].doc, r[t].stato);
      if (QA.nascosto.get(i.id, t)?.chiave === chiave) continue;
      avvisi.push({ impresa: i, chiaveTipo: t, tipo: TIPI[t], stato: r[t].stato });
    }
  }
  return avvisi;
}

/** Nasconde un avviso (o tutti, senza argomenti) finché non cambia il documento o il suo stato. */
function nascondiAvviso(impresaId, tipo) {
  for (const a of avvisiScadenze()) {
    if (impresaId && (a.impresa.id !== impresaId || a.chiaveTipo !== tipo)) continue;
    const r = riepilogo(a.impresa.id)[a.chiaveTipo];
    QA.nascondi.run(a.impresa.id, a.chiaveTipo, chiaveAvviso(r.doc, r.stato));
  }
}

// ---------- Promemoria alle imprese ----------
/** Indirizzo a cui scrivere: email normale se c'è, altrimenti PEC. */
const destinatario = (i) => i.email || i.pec || '';

/** Documenti principali da sistemare, con la data dell'ultimo promemoria inviato. */
function daSollecitare(impresaId) {
  const r = riepilogo(impresaId);
  const ultimi = Object.fromEntries(Q.ultimiPromemoria.all(impresaId).map((u) => [u.tipo, u.il]));
  return PRINCIPALI.filter((t) => r[t].stato.codice !== 'ok')
    .map((t) => ({ tipo: t, nome: TIPI[t], doc: r[t].doc, stato: r[t].stato, ultimo: ultimi[t] || null }));
}

const dataIt = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');
function rigaDocumento(v) {
  const c = v.stato.codice;
  if (c === 'mancante') return `- ${v.nome}: non ci risulta ancora consegnato`;
  if (c === 'insufficiente') return `- ${v.nome}: ${v.stato.testo}`;
  if (c === 'scaduto') return `- ${v.nome}: ${v.tipo === 'visura' ? 'da aggiornare (più vecchia di 6 mesi)' : `scaduto il ${dataIt(v.doc.scadenza)}`}`;
  return `- ${v.nome}: scade il ${dataIt(v.doc.scadenza)}`;
}

/** Testo dell'email di promemoria (solo testo, nessun link). */
function testoPromemoria(impresa, voci) {
  const cantieri = Q.lavoriImpresa.all(impresa.id).filter((l) => !['Completato', 'Sospeso'].includes(l.stato));
  const uno = voci.length === 1;
  return [
    `Buongiorno,`,
    ``,
    `vi scriviamo per ricordarvi che per ${impresa.ragione_sociale} ${uno ? 'il seguente documento è da aggiornare' : 'i seguenti documenti sono da aggiornare'}:`,
    ``,
    ...voci.map(rigaDocumento),
    ``,
    ...(cantieri.length ? [`${uno ? 'Il documento serve' : 'I documenti servono'} per ${cantieri.length === 1 ? 'il cantiere' : 'i cantieri'}: ${cantieri.map((l) => l.titolo).join('; ')}.`, ``] : []),
    `Vi chiediamo di inviarci ${uno ? 'il documento aggiornato' : 'i documenti aggiornati'} rispondendo a questa email.`,
    ``,
    `Grazie e buon lavoro.`,
  ].join('\n');
}

/**
 * Invia il promemoria per un documento (tipo) o per tutti quelli da sistemare (tipo vuoto).
 * Restituisce { ok, a, n } oppure { ok: false, motivo }.
 */
async function inviaPromemoria(impresa, tipo, invia) {
  const a = destinatario(impresa);
  if (!a) return { ok: false, motivo: 'Manca l\'indirizzo: aggiungi email o PEC nei dati dell\'impresa.' };
  let voci = daSollecitare(impresa.id);
  if (tipo) voci = voci.filter((v) => v.tipo === tipo);
  if (!voci.length) return { ok: false, motivo: 'Nessun documento da sollecitare: risultano tutti in regola.' };
  const oggetto = voci.length === 1
    ? `Promemoria: ${voci[0].nome} da aggiornare – ${impresa.ragione_sociale}`
    : `Promemoria: documenti da aggiornare – ${impresa.ragione_sociale}`;
  const inviata = await invia({ a, oggetto, testo: testoPromemoria(impresa, voci) });
  if (!inviata) return { ok: false, motivo: 'Email non inviata: la posta del sito non è configurata.' };
  for (const v of voci) Q.registraPromemoria.run(impresa.id, v.tipo, a);
  return { ok: true, a, n: voci.length };
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

function percorsoVerbale(v) {
  if (!v || !v.file) return null;
  const abs = path.join(dirVerbali, String(v.lavoro_id), v.file);
  return abs.startsWith(dirVerbali + path.sep) && fs.existsSync(abs) ? abs : null;
}

async function salvaVerbale(lavoroId, dati, tmp, nomeOriginale) {
  const id = Number(Q.inserisciVerbale.run({ lavoro_id: lavoroId, ...dati }).lastInsertRowid);
  if (tmp) {
    const nome = `${id}-${nomeSicuro(nomeOriginale) || 'verbale.pdf'}`;
    const dir = path.join(dirVerbali, String(lavoroId));
    await fsp.mkdir(dir, { recursive: true });
    await fsp.copyFile(tmp, path.join(dir, nome));
    Q.fileVerbale.run(nome, id);
  }
  return id;
}

async function eliminaVerbale(lavoroId, id) {
  const v = Q.verbale.get(id, lavoroId);
  if (!v) return false;
  const abs = percorsoVerbale(v);
  if (abs) await fsp.rm(abs, { force: true });
  Q.eliminaVerbale.run(id, lavoroId);
  return true;
}

/** Quando un lavoro viene eliminato dall'app: via anche i file dei suoi verbali. */
async function eliminaFileLavoro(lavoroId) {
  await fsp.rm(path.join(dirVerbali, String(Number(lavoroId))), { recursive: true, force: true });
}

module.exports = {
  destinatario, daSollecitare, testoPromemoria, inviaPromemoria,
  TIPI_VERBALE, percorsoVerbale, salvaVerbale, eliminaVerbale, eliminaFileLavoro,
  TIPI, PRINCIPALI, CREDITI_MINIMI, Q,
  scadenzaPredefinita, statoDocumento, riepilogo, impreseDelLavoro, avvisiScadenze, nascondiAvviso,
  percorsoFile, salvaDocumento, eliminaDocumento, eliminaImpresa,
};
