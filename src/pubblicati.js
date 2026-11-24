'use strict';
/**
 * Regola di riservatezza dell'area clienti: il cliente vede SOLO
 *  - i file che lo studio mette nella sottocartella "Presentazione" di una pratica (automatico);
 *  - i documenti che lo studio ha pubblicato uno per uno.
 * Tutto il resto della cartella resta privato.
 *  - un file nuovo o mai pubblicato non è visibile;
 *  - se un file pubblicato viene modificato o sostituito, torna privato finché non lo si ripubblica;
 *  - i file il cui nome indica dati sensibili (documenti d'identità, dati sanitari, dati bancari…)
 *    non possono essere pubblicati.
 */
const fs = require('node:fs');
const db = require('./db');
const archivio = require('./archivio');

db.exec(`CREATE TABLE IF NOT EXISTS file_pubblicati (
  pratica_id  INTEGER NOT NULL REFERENCES pratiche(id) ON DELETE CASCADE,
  percorso    TEXT NOT NULL,
  dimensione  INTEGER NOT NULL,
  modificato  INTEGER NOT NULL,
  pubblicato_il TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (pratica_id, percorso)
)`);

// File che lo studio ha nascosto anche se sono nella cartella Presentazione
db.exec(`CREATE TABLE IF NOT EXISTS file_nascosti (
  pratica_id  INTEGER NOT NULL REFERENCES pratiche(id) ON DELETE CASCADE,
  percorso    TEXT NOT NULL,
  nascosto_il TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (pratica_id, percorso)
)`);

const q = {
  nascosti: db.prepare('SELECT percorso FROM file_nascosti WHERE pratica_id = ?'),
  eNascosto: db.prepare('SELECT 1 FROM file_nascosti WHERE pratica_id = ? AND percorso = ?'),
  metteNascosto: db.prepare('INSERT OR IGNORE INTO file_nascosti (pratica_id, percorso) VALUES (?, ?)'),
  togliNascosto: db.prepare('DELETE FROM file_nascosti WHERE pratica_id = ? AND percorso = ?'),
  perPratica: db.prepare('SELECT * FROM file_pubblicati WHERE pratica_id = ?'),
  uno: db.prepare('SELECT * FROM file_pubblicati WHERE pratica_id = ? AND percorso = ?'),
  metti: db.prepare(`INSERT INTO file_pubblicati (pratica_id, percorso, dimensione, modificato) VALUES (?, ?, ?, ?)
    ON CONFLICT (pratica_id, percorso) DO UPDATE SET dimensione = excluded.dimensione, modificato = excluded.modificato, pubblicato_il = datetime('now')`),
  togli: db.prepare('DELETE FROM file_pubblicati WHERE pratica_id = ? AND percorso = ?'),
  // Visure e planimetrie scelte in automatico (src/visure.js)
  visure: db.prepare('SELECT * FROM visure_auto WHERE pratica_id = ?'),
  visura: db.prepare('SELECT * FROM visure_auto WHERE pratica_id = ? AND percorso = ?'),
  escludi: db.prepare('UPDATE visure_auto SET escluso = ? WHERE pratica_id = ? AND percorso = ?'),
};

const SOGGETTO = 'una visura per soggetto, che elenca tutti gli immobili della persona';
/** La visura è pubblicata in automatico ed è ancora lo stesso file? */
const visuraAttiva = (v, dim, mtime) => Boolean(v) && v.esito === 'pubblica' && !v.escluso && v.dimensione === dim && Math.abs(v.modificato - mtime) <= 1;

const norm = (t) => ` ${String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

// Parole nel nome (o nella sottocartella) che indicano un documento con dati sensibili
const SENSIBILI = [
  ['documento d\'identità', /\b(carta( di| d)? identita|carta identita|c i|ci|documento( di| d)? identita|doc( di)? identita|documenti( di| d)? identita|identita|doc( di| d)? ide[a-z]*|doc id|docide[a-z]*|doc ident[a-z]*|passaporto|documento (del )?(geometra|tecnico|professionista|progettista|direttore lavori)|doc (geometra|tecnico)|patente|permesso( di)? soggiorno)\b/],
  ['codice fiscale o tessera sanitaria', /\b(codice fiscale|cod fiscale|cod fisc|c f|cf|tessera sanitaria)\b/],
  ['dati sulla salute', /\b(certificato medico|medic[oa]|sanitari[oa]|invalidita|disabilita|legge 104|diagnosi|referto|asl referto)\b/],
  ['dati bancari o reddituali', /\b(iban|estratto conto|coordinate bancarie|busta paga|buste paga|cedolino|redditi|modello 730|mod 730|isee|cud|unico pf|mutuo)\b/],
  ['stato civile e famiglia', /\b(stato di famiglia|certificato di residenza|certificato residenza|stato civile|atto di nascita|atto di morte|certificato di morte|testamento|separazione|divorzio)\b/],
  ['dati giudiziari', /\b(casellario|carichi pendenti|sentenza|decreto penale)\b/],
  ['procura o delega con documenti allegati', /\b(procura|delega|conferimento)\b/],
];

/** Restituisce il motivo per cui il file sembra sensibile, oppure null. */
function sembraSensibile(percorso) {
  if (contenitore(percorso)) return 'un archivio o un\'email salvata, che può contenere documenti riservati';
  const n = norm(percorso.replace(/\.[a-z0-9]{1,5}$/i, ''));
  for (const [motivo, re] of SENSIBILI) if (re.test(n)) return motivo;
  return null;
}

// Tolleranza di 1 ms: la data letta dall'elenco è arrotondata, quella salvata è troncata
// Cartella dei documenti da mostrare al cliente: tutto ciò che sta in una sottocartella "Presentazione"
// della pratica (anche "01 - Presentazione", "Presentazione CILA"…) è visibile in automatico, tranne i file sensibili.
// Contenitori che possono includere qualsiasi documento (email salvate, archivi): mai visibili al cliente
const CONTENITORI = /\.(eml|msg|zip|rar|7z|tar|gz|tgz)$/i;
const contenitore = (rel) => CONTENITORI.test(String(rel));

function automatico(rel) {
  const parti = String(rel).split(/[\\/]/).slice(0, -1);
  return parti.some((c) => /\bpresentazione\b/.test(norm(c)));
}

const stessoIstante = (a, b) => Math.abs(a - b) <= 1;
const stessoFile = (riga, f) => Boolean(riga) && riga.dimensione === f.dimensione && stessoIstante(riga.modificato, new Date(f.modificato).getTime());

/** Aggiunge a ogni file della pratica: pubblicato (bool), sensibile (motivo o null), cambiato (era pubblicato ma è stato modificato). */
function annota(pratica, file) {
  const righe = new Map(q.perPratica.all(pratica.id).map((r) => [r.percorso, r]));
  const visure = new Map(q.visure.all(pratica.id).map((r) => [r.percorso, r]));
  const nascosti = new Set(q.nascosti.all(pratica.id).map((r) => r.percorso));
  return file.map((f) => {
    const riga = righe.get(f.percorso);
    const v = visure.get(f.percorso);
    const sensibile = sembraSensibile(f.percorso) || (v && v.tipo === 'soggetto' ? SOGGETTO : null);
    const autoNascosto = automatico(f.percorso) && nascosti.has(f.percorso);
    const auto = automatico(f.percorso) && !autoNascosto;
    const visuraAuto = !auto && visuraAttiva(v, f.dimensione, new Date(f.modificato).getTime());
    return {
      ...f, sensibile, automatico: auto, autoNascosto, visuraAuto,
      notaVisura: v && v.tipo && !auto ? (v.escluso && v.esito === 'pubblica' ? 'Nascosta da te (il programma l\'avrebbe pubblicata)' : v.motivo) : null,
      pubblicato: !sensibile && (auto || visuraAuto || (!autoNascosto && stessoFile(riga, f))),
      cambiato: !auto && Boolean(riga) && !stessoFile(riga, f),
    };
  });
}

/** Il file (percorso relativo alla pratica) è visibile al cliente in questo momento? */
function visibile(lavoro, pratica, rel) {
  if (!pratica || !pratica.visibile || sembraSensibile(rel)) return false;
  if (automatico(rel)) return !q.eNascosto.get(pratica.id, rel) && Boolean(archivio.fileDocumento(lavoro, pratica.cartella, rel));
  const v = q.visura.get(pratica.id, rel);
  if (v && v.tipo === 'soggetto') return false;
  if (v && v.esito === 'pubblica' && !v.escluso) {
    const absV = archivio.fileDocumento(lavoro, pratica.cartella, rel);
    if (absV) { const st = fs.statSync(absV); if (visuraAttiva(v, st.size, st.mtimeMs)) return true; }
  }
  const riga = q.uno.get(pratica.id, rel);
  const abs = riga && archivio.fileDocumento(lavoro, pratica.cartella, rel);
  if (!abs) return false;
  const st = fs.statSync(abs);
  return st.size === riga.dimensione && stessoIstante(st.mtimeMs, riga.modificato);
}

/** Pubblica un file. Restituisce { ok } oppure { ok: false, motivo }. */
function pubblica(lavoro, pratica, rel) {
  const motivo = sembraSensibile(rel);
  if (motivo) return { ok: false, motivo: `il nome indica ${motivo}` };
  const v = q.visura.get(pratica.id, rel);
  if (v && v.tipo === 'soggetto') return { ok: false, motivo: `è ${SOGGETTO}` };
  if (v) q.escludi.run(0, pratica.id, rel);
  if (automatico(rel)) { q.togliNascosto.run(pratica.id, rel); return { ok: true }; }
  const abs = archivio.fileDocumento(lavoro, pratica.cartella, rel);
  if (!abs) return { ok: false, motivo: 'file non trovato' };
  const st = fs.statSync(abs);
  q.metti.run(pratica.id, rel, st.size, Math.floor(st.mtimeMs));
  return { ok: true };
}
const nascondi = (pratica, rel) => {
  // Una visura pubblicata in automatico, se nascosta a mano, resta nascosta
  const v = q.visura.get(pratica.id, rel);
  const visura = Boolean(v && v.esito === 'pubblica' && !v.escluso);
  if (v) q.escludi.run(1, pratica.id, rel);
  if (automatico(rel)) { q.metteNascosto.run(pratica.id, rel); return true; }
  return q.togli.run(pratica.id, rel).changes === 1 || visura;
};

module.exports = { automatico, sembraSensibile, annota, visibile, pubblica, nascondi };
