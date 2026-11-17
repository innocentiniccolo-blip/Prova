'use strict';
/**
 * Visure e planimetrie catastali: pubblicazione automatica di quelle dell'unità d'intervento.
 *
 * - Visure per immobile, planimetrie ed elaborati planimetrici dell'unità del lavoro: si pubblica la più recente.
 * - Visure di altre particelle o subalterni, versioni più vecchie, sub soppressi: restano private.
 * - Visure per soggetto (elencano tutti gli immobili della persona): sempre private, non pubblicabili.
 *
 * L'unità d'intervento si ricava, in ordine: dalla scheda immobile; dai documenti della pratica edilizia
 * (relazione tecnica, moduli SCIA/CILA/PdC, DOCFA); dalle visure che lo studio ha messo in Presentazione o pubblicato.
 * Se le fonti non sono d'accordo o mancano, non si pubblica nulla e il pannello chiede di confermarla.
 */
const fs = require('node:fs');
const db = require('./db');
const archivio = require('./archivio');
const scheda = require('./scheda');
const { testoPdf, isoData } = require('./ricevute');
const { Pratiche } = require('./modelli');
require('./pubblicati'); // crea la tabella file_pubblicati usata qui sotto

const q = {
  riga: db.prepare('SELECT * FROM visure_auto WHERE pratica_id = ? AND percorso = ?'),
  perLavoro: db.prepare('SELECT v.*, p.cartella AS pratica FROM visure_auto v JOIN pratiche p ON p.id = v.pratica_id WHERE p.lavoro_id = ?'),
  salvaLettura: db.prepare(`INSERT INTO visure_auto (pratica_id, percorso, dimensione, modificato, tipo, storica, unita, data, testo_doc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (pratica_id, percorso) DO UPDATE SET dimensione = excluded.dimensione, modificato = excluded.modificato,
      tipo = excluded.tipo, storica = excluded.storica, unita = excluded.unita, data = excluded.data, testo_doc = excluded.testo_doc`),
  esito: db.prepare('UPDATE visure_auto SET esito = ?, motivo = ? WHERE pratica_id = ? AND percorso = ?'),
  pubblicatiLavoro: db.prepare('SELECT f.pratica_id, f.percorso FROM file_pubblicati f JOIN pratiche p ON p.id = f.pratica_id WHERE p.lavoro_id = ?'),
  togliVecchie: db.prepare('DELETE FROM visure_auto WHERE pratica_id = ? AND percorso = ?'),
};

// ---------------------------------------------------------------- identificativi catastali
const N = '(?:n\\.?|n°|nr\\.?|:)?\\s*';
const FOGLIO = '(?:fogli[oa]|fg\\.?|f\\.)';
const PARTICELLA = '(?:particell[ae]|mappal[ei]|p\\.?\\s*lla|part\\.?|map\\.|num(?:ero)?\\.?)';
const SUB = '(?:subaltern[oi]|sub\\.?)';
const RE_ID = new RegExp(`\\b${FOGLIO}\\s*${N}(\\d{1,4})[^\\d\\n]{0,25}?${PARTICELLA}\\s*${N}(\\d{1,5})(?:[^\\d\\n]{0,20}?${SUB}\\s*${N}(\\d{1,4}(?:\\s*[-,e]\\s*\\d{1,4})*))?`, 'gi');

/** Unità {f, p, s} citate nel testo; con contesto=true solo quelle precedute da «censito», «identificato»… */
function identificativi(testo, { contesto = false } = {}) {
  const t = String(testo || '').replace(/\s+/g, ' ');
  const out = [];
  for (const m of t.matchAll(RE_ID)) {
    if (contesto) {
      const prima = t.slice(Math.max(0, m.index - 140), m.index).toLowerCase();
      if (!/censit|identificat|distint|riportat|catast|individuat|rappresentat|accatastat|n\.?c\.?e\.?u|n\.?c\.?t/.test(prima)) continue;
      if (/confin|adiacent|limitrof|vicin/.test(t.slice(Math.max(0, m.index - 40), m.index).toLowerCase())) continue;
    }
    const subs = m[3] ? m[3].split(/\s*[-,e]\s*/).filter(Boolean) : [''];
    for (const s of subs) {
      const u = { f: String(Number(m[1])), p: String(Number(m[2])), s: s ? String(Number(s)) : '' };
      if (!out.some((x) => chiave(x) === chiave(u))) out.push(u);
    }
  }
  return out;
}
const chiave = (u) => `${u.f}/${u.p}/${u.s || ''}`;
const descrivi = (u) => `fg. ${u.f} part. ${u.p}${u.s ? ` sub. ${u.s}` : ''}`;
/** Stessa unità: stesso foglio e particella; il sub conta solo se c'è da entrambe le parti. */
const corrisponde = (a, b) => a.f === b.f && a.p === b.p && (!a.s || !b.s || a.s === b.s);

// ---------------------------------------------------------------- lettura dei documenti
/** Tipo di documento catastale: soggetto | immobile | planimetria | elaborato | null. */
function tipoCatastale(testo) {
  const t = String(testo || '').slice(0, 4000);
  if (/visura\s+(?:storica\s+|attuale\s+)?per\s+soggetto/i.test(t) || /dati\s+della\s+richiesta[\s\S]{0,200}(?:denominazione|cognome|codice\s+fiscale)\s*:/i.test(t) && !/per\s+immobile/i.test(t)) return 'soggetto';
  if (/visura\s+(?:storica\s+|attuale\s+|ordinaria\s+)?per\s+immobile/i.test(t) || /visura\s+(?:storica|catastale)/i.test(t) && /foglio/i.test(t)) return 'immobile';
  if (/elaborato\s+planimetrico|elenco\s+(?:dei\s+)?subalterni/i.test(t)) return 'elaborato';
  if (/planimetria\s+(?:di\s+)?(?:u\.?i\.?u|unit)|scheda\s+n\.\s*\d|planimetria\s+catastale/i.test(t) || /catasto\s+dei\s+fabbricati/i.test(t) && /planimetria/i.test(t)) return 'planimetria';
  return null;
}

/** Unità richiesta in una visura/planimetria: la prima indicata (sezione «Dati della richiesta» o intestazione). */
function unitaDocumento(testo, tipo) {
  const t = String(testo || '');
  const richiesta = t.match(/dati\s+della\s+richiesta([\s\S]{0,600})/i);
  const zona = richiesta ? richiesta[1] : t.slice(0, 2500);
  const u = identificativi(zona);
  if (u.length) return tipo === 'elaborato' ? [{ ...u[0], s: '' }] : [u[0]];
  return identificativi(t).slice(0, 1);
}

function dataDocumento(testo) {
  const t = String(testo || '');
  const m = t.match(/\bData:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i) || t.match(/(?:visura|richiesta)[^\n]{0,60}?(\d{1,2}\/\d{1,2}\/\d{4})/i);
  return m ? isoData(m[1]) : null;
}

/** Documento della pratica edilizia che indica l'unità d'intervento (non visure, non planimetrie). */
const DOC_FONTE = /relazion|scia|cila|\bcil\b|permesso|\bpdc\b|asseveraz|modello|istanza|domanda|docfa|variazione|accatast|notifica|progett/i;

/** Legge i PDF nuovi o cambiati del lavoro e ne salva tipo, unità e data (una volta per file). */
async function leggiFile(lavoro) {
  const righe = [];
  for (const p of Pratiche.perLavoro.all(lavoro.id)) {
    let file = [];
    try { file = await archivio.documentiPratica(lavoro, p.cartella); } catch { continue; }
    const presenti = new Set();
    for (const f of file) {
      if (!/\.pdf$/i.test(f.nome) || f.dimensione > 12 * 1024 * 1024) continue;
      presenti.add(f.percorso);
      const mtime = Math.floor(new Date(f.modificato).getTime());
      let r = q.riga.get(p.id, f.percorso);
      if (!r || r.dimensione !== f.dimensione || Math.abs(r.modificato - mtime) > 1) {
        const abs = archivio.fileDocumento(lavoro, p.cartella, f.percorso);
        let testo = '';
        try { testo = abs ? await testoPdf(abs, { pagine: 2 }) : ''; } catch { testo = ''; }
        const tipo = tipoCatastale(testo);
        const unita = tipo ? unitaDocumento(testo, tipo) : [];
        // Documenti della pratica edilizia: si conservano le unità citate con il loro contesto
        let doc = null;
        if (!tipo && DOC_FONTE.test(f.percorso)) {
          let lungo = testo;
          try { if (abs) lungo = await testoPdf(abs, { pagine: 15 }); } catch { /* resta il testo breve */ }
          doc = JSON.stringify(unitaDocFonte(lungo));
        }
        q.salvaLettura.run(p.id, f.percorso, f.dimensione, mtime, tipo, tipo === 'immobile' && /storica/i.test(testo.slice(0, 2000)) ? 1 : 0,
          JSON.stringify(unita), tipo ? dataDocumento(testo) : null, doc);
        r = q.riga.get(p.id, f.percorso);
      }
      righe.push({ ...r, pratica: p.cartella, praticaRiga: p, file: f });
    }
    // File spariti dalla cartella
    for (const v of db.prepare('SELECT percorso FROM visure_auto WHERE pratica_id = ?').all(p.id)) if (!presenti.has(v.percorso)) q.togliVecchie.run(p.id, v.percorso);
  }
  return righe;
}

/** Unità citate in un documento della pratica edilizia; nei DOCFA anche quelle soppresse. */
function unitaDocFonte(testo) {
  const t = String(testo || '');
  const unita = identificativi(t, { contesto: true });
  const soppresse = [];
  if (/docfa|dichiarazione\s+di\s+variazione|accatastamento|denuncia\s+di\s+variazione/i.test(t)) {
    for (const riga of t.split('\n')) {
      if (/soppress/i.test(riga)) for (const u of identificativi(riga)) soppresse.push(u);
      if (/costituit|variat|nuova|derivat/i.test(riga)) for (const u of identificativi(riga)) if (!unita.some((x) => chiave(x) === chiave(u))) unita.push(u);
    }
  }
  return { unita: unita.filter((u) => !soppresse.some((s) => chiave(s) === chiave(u))), soppresse };
}

// ---------------------------------------------------------------- unità d'intervento
/** { fonte, unita[], soppresse[], conflitto: [[unità del doc A], [unità del doc B]] | null } */
function unitaIntervento(lavoro, righe, pubblicati) {
  const s = scheda.leggi(lavoro);
  if (s.catasto) {
    const u = identificativi(s.catasto);
    if (u.length) return { fonte: 'scheda immobile', unita: u, soppresse: [], conflitto: null };
  }
  const docs = righe.filter((r) => r.testo_doc).map((r) => ({ nome: r.file.nome, ...JSON.parse(r.testo_doc) })).filter((d) => d.unita.length);
  const soppresse = docs.flatMap((d) => d.soppresse || []);
  if (docs.length) {
    // Fonti in disaccordo: due documenti che non hanno nessuna unità in comune
    for (let i = 0; i < docs.length; i++) {
      for (let j = i + 1; j < docs.length; j++) {
        const comune = docs[i].unita.some((a) => docs[j].unita.some((b) => corrisponde(a, b)));
        const docfa = /docfa|variazion|accatast/i.test(docs[i].nome + docs[j].nome);
        if (!comune && !docfa) return { fonte: 'documenti', unita: [], soppresse, conflitto: [docs[i], docs[j]].map((d) => ({ nome: d.nome, unita: d.unita })) };
      }
    }
    const unita = [];
    for (const d of docs) for (const u of d.unita) if (!unita.some((x) => chiave(x) === chiave(u)) && !soppresse.some((x) => chiave(x) === chiave(u))) unita.push(u);
    // Se un documento indica il sub e un altro solo foglio e particella, basta quella con il sub
    const conSub = unita.filter((u) => u.s);
    return { fonte: `documenti (${docs.map((d) => d.nome).join(', ')})`, unita: conSub.length ? conSub : unita, soppresse, conflitto: null };
  }
  // Visure scelte dallo studio (Presentazione o pubblicate a mano)
  const scelte = righe.filter((r) => ['immobile', 'planimetria'].includes(r.tipo) && (automaticoPresentazione(r.percorso) || pubblicati.has(`${r.pratica_id}|${r.percorso}`)));
  const unita = [];
  for (const r of scelte) for (const u of JSON.parse(r.unita || '[]')) if (!unita.some((x) => chiave(x) === chiave(u))) unita.push(u);
  if (unita.length) return { fonte: 'visure scelte dallo studio', unita, soppresse, conflitto: null };
  return { fonte: null, unita: [], soppresse, conflitto: null };
}

const automaticoPresentazione = (rel) => String(rel).split(/[\\/]/).slice(0, -1).some((c) => /\bpresentazione\b/i.test(c));
const formatta = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
const NOMI = { immobile: 'visura', planimetria: 'planimetria', elaborato: 'elaborato planimetrico' };

const statoLavori = new Map();

/** Rilegge i file del lavoro e decide quali visure/planimetrie pubblicare. */
async function aggiornaLavoro(lavoro) {
  const righe = await leggiFile(lavoro);
  const pubblicati = new Set(q.pubblicatiLavoro.all(lavoro.id).map((r) => `${r.pratica_id}|${r.percorso}`));
  const ui = unitaIntervento(lavoro, righe, pubblicati);
  const catastali = righe.filter((r) => r.tipo && !automaticoPresentazione(r.percorso));
  statoLavori.set(lavoro.id, {
    ...ui, documenti: righe.filter((r) => r.tipo && r.tipo !== 'soggetto').length,
    unitaTesto: ui.unita.map(descrivi).join(', '),
    conflitto: ui.conflitto && ui.conflitto.map((c) => ({ ...c, testo: c.unita.map(descrivi).join(', ') })),
  });

  // Candidate: documenti dell'unità d'intervento; per ogni unità e tipo vince il più recente
  const vincenti = new Map();
  const decisioni = new Map();
  for (const r of catastali) {
    const u = JSON.parse(r.unita || '[]')[0];
    let esito = 'privata';
    let motivo;
    if (r.tipo === 'soggetto') motivo = 'Visura per soggetto: elenca tutti gli immobili della persona, resta sempre privata';
    else if (ui.conflitto) motivo = 'Unità d\'intervento da confermare (i documenti non sono d\'accordo)';
    else if (!ui.unita.length) motivo = 'Unità d\'intervento non trovata nei documenti';
    else if (!u) motivo = 'Identificativi catastali non leggibili';
    else if (ui.soppresse.some((x) => chiave(x) === chiave(u))) motivo = `Subalterno soppresso (${descrivi(u)})`;
    else if (!ui.unita.some((x) => corrisponde(x, u))) motivo = `Altra unità (${descrivi(u)})`;
    else {
      esito = 'candidata';
      const k = `${r.tipo}|${chiave(u)}`;
      const ordine = `${r.data || ''}|${String(r.modificato).padStart(15, '0')}`;
      const att = vincenti.get(k);
      if (!att || ordine > att.ordine) vincenti.set(k, { r, ordine, u });
    }
    decisioni.set(`${r.pratica_id}|${r.percorso}`, { r, esito, motivo, u });
  }
  for (const d of decisioni.values()) {
    if (d.esito === 'candidata') {
      const v = vincenti.get(`${d.r.tipo}|${chiave(d.u)}`);
      if (v.r === d.r) { d.esito = 'pubblica'; d.motivo = `Pubblicata in automatico: ${NOMI[d.r.tipo]} dell'unità d'intervento (${descrivi(d.u)})${d.r.data ? ` del ${formatta(d.r.data)}` : ''}`; }
      else { d.esito = 'privata'; d.motivo = `C'è una ${NOMI[d.r.tipo]} più recente della stessa unità (${v.r.file.nome})`; }
    }
    q.esito.run(d.esito, d.motivo, d.r.pratica_id, d.r.percorso);
  }
  return statoLavori.get(lavoro.id);
}

module.exports = { aggiornaLavoro, stato: (id) => statoLavori.get(id) || null, identificativi, tipoCatastale, unitaDocumento, dataDocumento, unitaDocFonte, unitaIntervento, corrisponde, descrivi };
