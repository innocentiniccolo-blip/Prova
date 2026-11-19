'use strict';
/**
 * Imprese del cantiere lette in automatico dalla cartella "Sicurezza" del lavoro.
 *
 * Struttura attesa (quella dello studio):
 *   <lavoro>/007-Sicurezza/<impresa>/Visura ... .pdf, DURC ... .pdf, Patente ... .pdf, altri PDF
 *
 * Per ogni sottocartella di "Sicurezza" l'app crea (o ritrova, per partita IVA o nome) l'impresa,
 * la collega al cantiere, attiva la sezione sicurezza del lavoro e registra i documenti leggendo
 * dai PDF date, scadenze, numero di patente e crediti. Ogni file viene importato una sola volta
 * (di nuovo solo se cambia).
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const db = require('./db');
const archivio = require('./archivio');
const imprese = require('./imprese');
const { isoData } = require('./ricevute');
const { testoDocumento } = require('./ocr');
const { Lavori } = require('./modelli');

db.exec(`CREATE TABLE IF NOT EXISTS import_sicurezza (
  lavoro_id  INTEGER NOT NULL REFERENCES lavori(id) ON DELETE CASCADE,
  percorso   TEXT NOT NULL,
  firma      TEXT NOT NULL,
  impresa_id INTEGER,
  documento_id INTEGER,
  PRIMARY KEY (lavoro_id, percorso)
)`);
const q = {
  visto: db.prepare('SELECT * FROM import_sicurezza WHERE lavoro_id = ? AND percorso = ?'),
  segna: db.prepare(`INSERT INTO import_sicurezza (lavoro_id, percorso, firma, impresa_id, documento_id) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (lavoro_id, percorso) DO UPDATE SET firma = excluded.firma, impresa_id = excluded.impresa_id, documento_id = excluded.documento_id`),
  perPiva: db.prepare('SELECT * FROM imprese WHERE piva = ? LIMIT 1'),
  perNome: db.prepare('SELECT * FROM imprese WHERE ragione_sociale = ? COLLATE NOCASE LIMIT 1'),
  completa: db.prepare(`UPDATE imprese SET piva = COALESCE(piva, ?), sede = COALESCE(sede, ?), pec = COALESCE(pec, ?) WHERE id = ?`),
};

const CARTELLA_SICUREZZA = /sicurezza/i;
const data = (testo, re) => { const m = testo.match(re); return m ? isoData(m[1]) : null; };
const pulisci = (s) => (s || '').replace(/\s+/g, ' ').trim();

/** Riconosce il tipo di documento e ne estrae i dati principali. */
function leggiDocumento(nome, testo) {
  const t = testo || '';
  const n = nome.toLowerCase();
  const dati = { tipo: 'altro', descrizione: nome.replace(/\.(pdf|p7m)$/gi, ''), anagrafica: {} };

  if (/durc/.test(n) || /Durc On ?Line/i.test(t)) {
    dati.tipo = 'durc';
    dati.rilascio = data(t, /Data richiesta\s+(\d{2}\/\d{2}\/\d{4})/i);
    dati.scadenza = data(t, /Scadenza validit\S*\s+(\d{2}\/\d{2}\/\d{4})/i);
    const prot = t.match(/Numero Protocollo\s+([A-Z]+[\\_ ]*\d+)/i);
    if (prot) dati.numero = prot[1].replace(/\\/g, '').replace(/\s+/g, '');
    const den = t.match(/Denominazione\/ragione sociale\s+(.+?)\s+Codice fiscale/i);
    if (den) dati.anagrafica.nome = pulisci(den[1]);
  } else if (/visura|camerale/.test(n) || /VISURA (ORDINARIA|STORICA)/i.test(t)) {
    dati.tipo = 'visura';
    dati.rilascio = data(t, /estratto dal Registro Imprese in data\s+(\d{2}\/\d{2}\/\d{4})/i);
    const den = t.match(/VISURA (?:ORDINARIA|STORICA) DELL['’]IMPRESA\s+(.+?)\s+(?:Registro Imprese|Codice Fiscale)/i);
    if (den) dati.anagrafica.nome = pulisci(den[1]);
    const piva = t.match(/Partita IVA\s+(\d{11})/i) || t.match(/Codice fiscale\s+(?:e n\.\s*iscr\.\s*al Registro Imprese\s+)?(\d{11})\b/i);
    if (piva) dati.anagrafica.piva = piva[1];
    const rea = t.match(/Numero REA\s+([A-Z]{2}\s*-\s*\d{3,9})/i);
    if (rea) dati.anagrafica.rea = rea[1].replace(/\s+/g, '');
    const pec = t.match(/Domicilio digitale\/PEC\s+(\S+@\S+)/i);
    if (pec) dati.anagrafica.pec = pec[1];
    const sede = t.match(/1 Sede\s+Indirizzo Sede\s+(.+?)\s+(.+?)\s+CAP\s+(\d{5})/i);
    if (sede) dati.anagrafica.sede = pulisci(`${sede[2]}, ${sede[3]} ${sede[1]}`);
  } else if (/patente|crediti/.test(n) || /Patente a Crediti|Numero patente\s|\bPAC-[A-Z0-9]{2,4}-/i.test(t)) {
    dati.tipo = 'patente';
    const num = t.match(/\b(PAC-[A-Z0-9]{2,4}-[A-Z0-9]{2,4}-[A-Z0-9]{2,4})\b/i);
    if (num) dati.numero = num[1].toUpperCase();
    // portale INL stampato: "Punteggio iniziale Punteggio attuale" e sotto "40 38" (conta il secondo, l'attuale)
    const cr = t.match(/Punteggio iniziale\s+Punteggio attuale\s+\d{1,3}\s+(\d{1,3})\b/i)
      || t.match(/Punteggio attuale\s+(\d{1,3})\b/i);
    if (cr) dati.crediti = Number(cr[1]);
    dati.rilascio = data(t, /Data (?:di )?rilascio(?: Patente Associata)?:?\s+(\d{2}\/\d{2}\/\d{4})/i)
      // a colonne: "Numero patente  Data di rilascio  Stato patente" e sotto "PAC-… 01/10/2024 Attiva"
      || data(t, /Data (?:di )?rilascio[^\d]{0,60}?\n[^\n]*?(\d{2}\/\d{2}\/\d{4})/i);
    const den = t.match(/Ragione (?:sociale|Sociale)(?:\/Nome e cognome lav\. autonomo)?:?\s+(.+?)\s+Codice Fiscale/i);
    if (den) dati.anagrafica.nome = pulisci(den[1]);
  }
  return dati;
}

/** Trova o crea l'impresa: prima per partita IVA, poi per nome (dai documenti o dalla cartella). */
function impresaPer(nomeCartella, anagrafica) {
  let imp = anagrafica.piva ? q.perPiva.get(anagrafica.piva) : null;
  if (!imp && anagrafica.nome) imp = q.perNome.get(anagrafica.nome);
  if (!imp) imp = q.perNome.get(nomeCartella);
  if (!imp) {
    const r = imprese.Q.inserisci.run({
      ragione_sociale: anagrafica.nome || nomeCartella, piva: anagrafica.piva || null, sede: anagrafica.sede || null,
      pec: anagrafica.pec || null, email: null, telefono: null, autonomo: 0, nota: null,
    });
    imp = imprese.Q.perId.get(Number(r.lastInsertRowid));
  } else {
    q.completa.run(anagrafica.piva || null, anagrafica.sede || null, anagrafica.pec || null, imp.id);
  }
  return imp;
}

/** Importa le imprese della cartella Sicurezza di un lavoro. Restituisce il numero di documenti nuovi. */
async function importaLavoro(lavoro) {
  const base = archivio.risolviDentro(config.archivioDir, lavoro.cartella);
  if (!base || !fs.existsSync(base)) return 0;
  const cartSic = fs.readdirSync(base, { withFileTypes: true }).find((d) => d.isDirectory() && CARTELLA_SICUREZZA.test(d.name));
  if (!cartSic) return 0;
  const dirSic = path.join(base, cartSic.name);
  let nuovi = 0;
  let trovate = 0;
  for (const d of fs.readdirSync(dirSic, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const dirImp = path.join(dirSic, d.name);
    const files = fs.readdirSync(dirImp, { withFileTypes: true }).filter((f) => f.isFile() && /\.pdf$/i.test(f.name));
    if (!files.length) continue;
    trovate++;
    // Legge prima tutti i documenti, così l'anagrafica (P.IVA, nome) arriva dalla visura se c'è
    const letti = [];
    for (const f of files) {
      const abs = path.join(dirImp, f.name);
      const st = fs.statSync(abs);
      const rel = `${cartSic.name}/${d.name}/${f.name}`;
      const firma = `${st.size}:${Math.floor(st.mtimeMs)}`;
      const visto = q.visto.get(lavoro.id, rel);
      let testo = '';
      if (st.size <= 15 * 1024 * 1024) { try { testo = await testoDocumento(abs); } catch { /* PDF illeggibile: resta "altro" */ } }
      letti.push({ abs, rel, firma, visto, nome: f.name, dati: leggiDocumento(f.name, testo) });
    }
    const anagrafica = Object.assign({}, ...letti.map((x) => x.dati.anagrafica).reverse(),
      (letti.find((x) => x.dati.tipo === 'visura') || {}).dati?.anagrafica);
    const imp = impresaPer(d.name, anagrafica);
    if (!imprese.Q.collegamento.get(lavoro.id, imp.id)) imprese.Q.collega.run(lavoro.id, imp.id, null, 1);
    for (const x of letti) {
      if (x.visto && x.visto.firma === x.firma) continue;
      if (x.visto && x.visto.documento_id) await imprese.eliminaDocumento(x.visto.impresa_id, x.visto.documento_id).catch(() => {});
      const docId = await imprese.salvaDocumento(imp.id, x.dati, x.abs, x.nome);
      q.segna.run(lavoro.id, x.rel, x.firma, imp.id, docId);
      nuovi++;
    }
  }
  if (trovate && !lavoro.sicurezza) imprese.Q.impostaSicurezza.run(1, lavoro.id);
  return nuovi;
}

async function importaTutti() {
  let n = 0;
  for (const l of Lavori.tutti.all()) {
    try { n += await importaLavoro(l); } catch (e) { console.error(`Sicurezza ${l.codice}:`, e.message); }
  }
  return n;
}

module.exports = { impresaPer, importaLavoro, importaTutti, leggiDocumento };
