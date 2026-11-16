'use strict';
/**
 * Riconoscimento delle ricevute salvate nelle cartelle delle pratiche.
 * Le regole sono scritte sui formati reali usati dallo studio:
 *  - Comuni: ricevute URP/servizi on line, "Ricevuta Protocollo" del portale regionale,
 *    "Ricevuta di Protocollazione", ricevute telematiche SUE
 *  - SUAP / STAR: avviso di ricevimento e attestazione di presentazione
 *  - Catasto: ricevuta di avvenuta denuncia/dichiarazione DOCFA
 *  - Regione Toscana: ricevuta di trasmissione APE (RIAPE) e APE scaricato da SIERT
 *  - ENEA: scheda descrittiva chiusa con codice CPID
 *  - ASL: notifica preliminare di cantiere
 * Restituisce { tipo, stato, data (AAAA-MM-GG), protocollo } oppure null.
 */
const fs = require('node:fs');

let pdfjs;
/** Estrae il testo delle prime pagine (di serie tre) con pdf.js (Mozilla), riga per riga. */
async function testoPdf(abs, { pagine = 3, dati } = {}) {
  pdfjs = pdfjs || await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(dati || await fs.promises.readFile(abs));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  try {
    let testo = '';
    for (let i = 1; i <= Math.min(pagine, doc.numPages); i++) {
      const pagina = await doc.getPage(i);
      const contenuto = await pagina.getTextContent();
      testo += contenuto.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : ' ')).join('') + '\n';
    }
    return testo;
  } finally {
    await doc.destroy();
  }
}

/** dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy oppure yyyy-mm-dd → yyyy-mm-dd */
function isoData(s) {
  if (!s) return null;
  let m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = String(s).match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (!m) return null;
  const [g, me, a] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (g < 1 || g > 31 || me < 1 || me > 12) return null;
  return `${a}-${String(me).padStart(2, '0')}-${String(g).padStart(2, '0')}`;
}

const D = '(\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4}|\\d{4}-\\d{2}-\\d{2})';
const trova = (t, re) => { const m = t.match(re); return m ? m[1].trim() : null; };

/** Inizio del documento: intestazione e oggetto, dove si dice di che comunicazione si tratta. */
const testa = (t) => String(t).slice(0, 1500);
/** Righe dell'oggetto («Oggetto:», «avente come oggetto:», «Tipo pratica», …) con la riga successiva. */
function oggetto(t) {
  const righe = String(t).split('\n');
  const out = [];
  righe.forEach((r, i) => { if (/oggetto|tipo\s*(di\s*)?(pratica|domanda|istanza|comunicazione)|tipologia|intervento\s*:/i.test(r)) out.push(r, righe[i + 1] || ''); });
  return out.join(' ');
}

/**
 * Fase della pratica a cui si riferisce la ricevuta: presentazione (di serie), integrazione,
 * inizio lavori o fine lavori. Conta il nome del file e l'inizio/oggetto del documento,
 * non le frasi più in basso (es. «data presunta di inizio lavori» in una SCIA).
 */
function faseDa(testo, nome = '') {
  const n = String(nome).replace(/[_.-]+/g, ' ');
  const zona = `${n}\n${testa(testo)}\n${oggetto(testo)}`;
  if (/fine\s*(dei\s*)?lavori|ultimazione\s*(dei\s*)?lavori|regolare\s*esecuzione|struttura\s*ultimata|\bD\.?R\.?E\b/i.test(zona)) return 'fine';
  if (/inizio\s*(dei\s*)?lavori|\bC\.?I\.?L\.?\s|comunicazione\s*di\s*avvio/i.test(zona) && !/data\s*(presunta|prevista)\s*(di\s*)?inizio/i.test(zona)) return 'inizio';
  if (/integrazion|documentazione\s*integrativa|conformazion/i.test(zona)) return 'integrazione';
  return 'presentazione';
}

// Ogni regola: test(testo, nome) → bool; estrai(testo) → { tipo, stato, fase, data, protocollo }
const REGOLE = [
  {
    nome: 'APE – ricevuta di trasmissione (RIAPE)',
    test: (t, n) => /trasmesso\s*telematicamente/i.test(t) && /APE\s*id/i.test(t) || /^RIAPE_/i.test(n) && /APE/i.test(t),
    estrai: (t) => ({
      tipo: 'ape', stato: 'Completata', fase: 'presentazione',
      data: isoData(trova(t, new RegExp(`trasmesso\\s*telematicamente\\s*in\\s*data\\s*${D}`, 'i')) || trova(t, new RegExp(`Data\\s*Ape\\s*:?\\s*${D}`, 'i'))),
      protocollo: trova(t, /APE\s*id\s*:?\s*(\d+)/i),
    }),
  },
  {
    nome: 'APE – attestato',
    test: (t) => /ATTESTATO\s*DI\s*PRESTAZIONE\s*ENERGETICA/i.test(t) && /CODICE\s*IDENTIFICATIVO/i.test(t),
    estrai: (t) => ({
      tipo: 'ape', stato: 'Completata', fase: 'presentazione',
      data: isoData(trova(t, new RegExp(`Data\\s*di\\s*emissione\\s*${D}`, 'i'))),
      protocollo: trova(t, /CODICE\s*IDENTIFICATIVO\s*:?\s*(\d+)/i),
    }),
  },
  {
    nome: 'Catasto – ricevuta DOCFA',
    test: (t) => /Ricevuta\s*di\s*Avvenuta\s*(Denuncia|Dichiarazione)/i.test(t),
    estrai: (t) => ({
      tipo: 'docfa', stato: 'Completata', fase: 'presentazione',
      data: isoData(trova(t, new RegExp(`Data\\s*:?\\s*${D}`, 'i'))),
      protocollo: trova(t, /Pratica\s*numero\s*:?\s*([A-Z]{2}\d{5,})/i),
    }),
  },
  {
    nome: 'ENEA – scheda chiusa (CPID)',
    test: (t, n) => /CPID\s*(?!annullato)\d{4,}-\d{4}E-[A-Z0-9]{16}/i.test(t) || /^CPID_/i.test(n),
    estrai: (t, n) => ({
      tipo: 'enea', stato: 'Completata', fase: 'presentazione',
      data: isoData(trova(t, /Data\s*chiusura\s*(\d{4}-\d{2}-\d{2})/i)),
      protocollo: trova(t, /CPID\s*(?!annullato)(\d{4,}-\d{4}E-[A-Z0-9]{16})/i) || trova(n, /CPID_([0-9A-Z-]+)/i),
    }),
  },
  {
    nome: 'ASL – notifica preliminare',
    test: (t) => /Notifica\s*Preliminare\s*Cantiere/i.test(t),
    estrai: (t) => ({
      tipo: 'asl', stato: 'Presentata', fase: 'presentazione',
      data: isoData(trova(t, new RegExp(`N°?\\s*Notifica\\s*:?\\s*\\d+\\s*[–-]?\\s*Data\\s*:?\\s*${D}`, 'i'))),
      protocollo: trova(t, /Protocollo\s*:?\s*([A-Z0-9/]+\/\d{4})/i) || trova(t, /N°?\s*Notifica\s*:?\s*(\d+)/i),
    }),
  },
  {
    // Fine lavori al Genio Civile: Dichiarazione di Regolare Esecuzione / Relazione a struttura ultimata / collaudo
    nome: 'Regione Toscana – fine lavori sismica (PORTOS)',
    test: (t) => /Settore\s*SISMICA/i.test(t) && /Regolare\s*Esecuzione|Fine\s*(dei\s*)?Lavori|Struttura\s*ultimata|Certificato\s*di\s*collaudo/i.test(testa(t)),
    estrai: (t) => ({
      tipo: 'sismica', stato: 'Completata', fase: 'fine',
      data: isoData(trova(t, new RegExp(`Data\\s*Invio(?:\\s*D\\.?R\\.?E\\.?)?\\s*:?\\s*${D}`, 'i')) || trova(t, new RegExp(`AOOGRT\\/SISMICA\\/\\d+[^\\n]*?del\\s*${D}`, 'i'))),
      protocollo: trova(t, /AOOGRT\/SISMICA\/(\d{6,})/i) || trova(t, /Deposito\s*n\.?\s*(\d+)/i),
    }),
  },
  {
    nome: 'Regione Toscana – deposito sismico (PORTOS)',
    test: (t) => /Settore\s*SISMICA/i.test(t) && /Attestazione\s*di\s*deposito/i.test(t) && !/integrazion|inizio\s*(dei\s*)?lavori/i.test(oggetto(t)),
    estrai: (t) => ({
      tipo: 'sismica', stato: 'Completata', fase: 'presentazione',
      data: isoData(trova(t, new RegExp(`Data\\s*Avviso\\s*${D}`, 'i'))),
      // «Protocollo n.» nell'intestazione a volte esce dal PDF in disordine: c'è anche nel testo («attribuito n. protocollo …»)
      protocollo: trova(t, /Protocollo\s*n\.?\s*(\d{6,})/i) || trova(t, /n\.?\s*protocollo\s*(\d{6,})/i),
    }),
  },
  {
    nome: 'Regione Toscana – comunicazione sismica (PORTOS)',
    test: (t, n) => /Settore\s*SISMICA/i.test(t) && /AOOGRT\/SISMICA\//i.test(t) && faseDa(t, n) !== 'presentazione',
    estrai: (t, n) => ({
      tipo: 'sismica', stato: 'Presentata', fase: faseDa(t, n),
      data: isoData(trova(t, new RegExp(`AOOGRT\\/SISMICA\\/\\d+[^\\n]*?del\\s*${D}`, 'i')) || trova(t, new RegExp(`Data\\s*Avviso\\s*${D}`, 'i'))),
      protocollo: trova(t, /AOOGRT\/SISMICA\/(\d{6,})/i) || trova(t, /Protocollo\s*n\.?\s*(\d{6,})/i),
    }),
  },
  {
    nome: 'SUAP – attestazione di presentazione',
    test: (t) => /ATTESTAZIONE\s*DI\s*PRESENTAZIONE/i.test(t) && /presentato\s*in\s*data/i.test(t),
    estrai: (t) => ({
      tipo: 'suap', stato: 'Presentata',
      data: isoData(trova(t, new RegExp(`presentato\\s*in\\s*data\\s*${D}`, 'i'))),
      protocollo: trova(t, /prot\.?\s*n\.?\s*(\d+)/i),
    }),
  },
  {
    nome: 'SUAP / STAR – avviso di ricevimento',
    test: (t) => /AVVISO\s*DI\s*RICEVIMENTO/i.test(t) && /IDENTIFICATIVO\s*PRATICA/i.test(t),
    estrai: (t) => ({
      tipo: 'suap', stato: 'Presentata',
      data: isoData(trova(t, new RegExp(`ricevuto\\s*in\\s*data\\s*${D}`, 'i'))),
      protocollo: trova(t, /IDENTIFICATIVO\s*PRATICA\s*:?\s*([A-Z0-9-]+)/i),
    }),
  },
  {
    nome: 'Comune – ricevuta servizi on line (URP)',
    test: (t) => /RICEVUTA\s*SERVIZI\s*ON\s*LINE/i.test(t),
    estrai: (t) => ({
      tipo: 'comune', stato: 'Presentata',
      data: isoData(trova(t, new RegExp(`Data\\s*-?\\s*Ora\\s*Richiesta\\s*:?\\s*${D}`, 'i'))),
      protocollo: trova(t, /protocollo\s*abbinato\s*alla\s*richiesta\s*è\s*:?\s*([\d./]+\d)/i),
    }),
  },
  {
    nome: 'Comune – Ricevuta Protocollo (portale regionale)',
    test: (t) => /Numero\s*protocollo/i.test(t) && /Data\s*protocollo/i.test(t),
    estrai: (t) => ({
      tipo: 'comune', stato: 'Presentata',
      data: isoData(trova(t, new RegExp(`Data\\s*protocollo\\s*:?\\s*${D}`, 'i'))),
      protocollo: trova(t, /Numero\s*protocollo\s*:?\s*(\d[\d./]*)/i),
    }),
  },
  {
    nome: 'Comune – ricevuta telematica SUE',
    test: (t) => /RICEVUTA\s*Telematica/i.test(t) && /Protocollo\s*N\.?/i.test(t),
    estrai: (t) => ({
      tipo: 'comune', stato: 'Presentata',
      data: isoData(trova(t, new RegExp(`Protocollo\\s*N\\.?\\s*\\d+\\s*Data\\.?\\s*:?\\s*${D}`, 'i')) || trova(t, new RegExp(`Trasmissione\\s*dell'istanza\\s*:?\\s*${D}`, 'i'))),
      protocollo: trova(t, /Protocollo\s*N\.?\s*:?\s*(\d+)/i),
    }),
  },
  {
    nome: 'Comune – ricevuta di protocollazione',
    test: (t) => /Ricevuta\s*di\s*(Protocollazione|presentazione\s*di\s*atto\s*al\s*protocollo)/i.test(t),
    estrai: (t) => ({
      tipo: 'comune', stato: 'Presentata',
      data: isoData(trova(t, new RegExp(`\\bl[iìí'’]\\s*,?\\s*${D}`, 'i')) || trova(t, new RegExp(`in\\s*data\\s*${D}`, 'i'))),
      protocollo: trova(t, /al\s*numero\s*(\d[\d./]*)/i),
    }),
  },
];

function riconosci(testo, nomeFile = '') {
  const t = String(testo || '').replace(/ /g, ' ');
  const n = String(nomeFile || '');
  if (!t.trim()) return null;
  for (const r of REGOLE) {
    if (!r.test(t, n)) continue;
    const esito = r.estrai(t, n);
    // Ricevute generiche del Comune / SUAP: la fase si capisce dal nome del file e dall'oggetto
    if (!esito.fase) esito.fase = faseDa(t, n);
    // Senza almeno una data o un numero la proposta non serve
    if (!esito.data && !esito.protocollo) continue;
    return { ...esito, regola: r.nome };
  }
  return null;
}

async function analizza(abs, nomeFile) {
  const testo = await testoPdf(abs);
  return riconosci(testo, nomeFile);
}

/** Da aumentare quando si aggiungono o correggono regole: le ricevute già lette vengono rilette. */
const VERSIONE_REGOLE = 2;

module.exports = { testoPdf, riconosci, analizza, isoData, faseDa, VERSIONE_REGOLE };
