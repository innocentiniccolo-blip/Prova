'use strict';
/**
 * Dati del fabbricato letti dai documenti del lavoro (relazione tecnica, APE, visure,
 * planimetrie catastali), per il fascicolo in PDF di agenzia e proprietario.
 *
 * Si leggono solo dati dell'immobile: nomi e codici fiscali dei proprietari non vengono mai estratti.
 * Ogni dato scritto dallo studio nella scheda immobile prevale su quello letto in automatico.
 */
const fs = require('node:fs');
const config = require('./config');
const pratiche = require('./pratiche');
const archivio = require('./archivio');
const scheda = require('./scheda');
const { testoPdf, isoData } = require('./ricevute');

const MAX_FILE = 20;
const MAX_BYTE = 25 * 1024 * 1024;

const tipoFile = (nome, pratica) => {
  const n = nome.toLowerCase();
  if (/relazion/.test(n) && !/paesagg|geolog|strut|calcol|legge\s*10|l\.?\s*10|energ/.test(n)) return 'relazione';
  if (/\bape\b|attestat|prestazione.?energ/.test(n)) return 'ape';
  if (/visur|catast|planimetr|elaborato|docfa|elenco.?subaltern/.test(n)) return 'catasto';
  if (/\bape\b|attestat/i.test(pratica)) return 'ape';
  if (/catast|docfa|visur/i.test(pratica)) return 'catasto';
  return null;
};
const PRIORITA = { relazione: 0, ape: 1, catasto: 2 };
const PAGINE = { relazione: 20, ape: 4, catasto: 3 };

/** PDF dentro una busta firmata .p7m (CAdES): il documento è contenuto per intero nella busta. */
function pdfDaP7m(buf) {
  const inizio = buf.indexOf('%PDF-');
  const fine = buf.lastIndexOf('%%EOF');
  return inizio >= 0 && fine > inizio ? buf.subarray(inizio, fine + 5) : null;
}

async function leggiTesto(abs, pagine) {
  if (/\.p7m$/i.test(abs)) {
    const pdf = pdfDaP7m(await fs.promises.readFile(abs));
    return pdf ? testoPdf(abs, { pagine, dati: pdf }) : '';
  }
  return testoPdf(abs, { pagine });
}

const spazi = (t) => String(t || '').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
const piatto = (t) => spazi(t).replace(/\n/g, ' ');
const maiuscole = (t) => /[a-zà-ü]/.test(t) ? t : t.toLowerCase().replace(/(^|[\s'’/-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

// ---------------------------------------------------------------- catasto
const N = '(?:n\\.?|n°|nr\\.?|num\\.?|:)?\\s*';
const RE_UNITA = new RegExp(`fogli[oa]\\s*(?:di\\s*mappa\\s*)?${N}(\\d{1,4})[^\\d]{0,30}?(?:particell[ae]|mappal[ei]|p\\.?\\s*lla|part\\.|map\\.)\\s*${N}(\\d{1,5})(?:[^\\d]{0,25}?(?:subaltern[oi]|sub\\.?)\\s*${N}(\\d{1,4}))?`, 'gi');
// Riga della tabella delle visure: «12 345 6 A/2 3 6,5 vani … Euro 520,00»
const RE_VISURA = /\b(\d{1,4})\s+(\d{1,5})\s+(\d{1,4})\s+(?:\d{1,2}\s+){0,2}([A-F]\/\d{1,2})\s+(\w{1,2})\s+([\d.,]+\s*(?:vani|m²|mq|m2))[\s\S]{0,80}?(?:Euro|€)\s*([\d.]+,\d{2})/g;

function dettagliCatastali(dopo) {
  const cat = dopo.match(/categoria\s*(?:catastale\s*)?[:\s]*([A-F])\s*\/\s*(\d{1,2})\b/i);
  const cla = dopo.match(/\bclasse\s*[:\s]*(\d{1,2}|U)\b(?!\s*energ)/i);
  const con = dopo.match(/consistenza\s*[:\s]*(?:di\s*)?([\d.,]+)\s*(vani|mq|m²|m2|metri\s+quadr\w*)/i);
  const ren = dopo.match(/rendita\s*(?:catastale\s*)?[:\s]*(?:di\s*|pari\s+a\s*)?(?:euro|€|eur)\s*([\d.]+,\d{2})/i);
  return {
    categoria: cat ? `${cat[1].toUpperCase()}/${cat[2]}` : '',
    classe: cla ? cla[1] : '',
    consistenza: con ? `${con[1]} ${/vani/i.test(con[2]) ? 'vani' : 'mq'}` : '',
    rendita: ren ? `€ ${ren[1]}` : '',
  };
}

function catasto(testo) {
  const t = piatto(testo);
  const unita = [];
  const chiave = (u) => `${u.foglio}/${u.particella}/${u.sub || ''}`;
  const aggiungi = (u) => {
    const gia = unita.find((x) => chiave(x) === chiave(u));
    if (!gia) unita.push(u);
    else for (const k of ['categoria', 'classe', 'consistenza', 'rendita']) gia[k] = gia[k] || u[k];
  };
  for (const m of t.matchAll(RE_VISURA)) {
    aggiungi({ foglio: m[1], particella: m[2], sub: m[3], categoria: m[4], classe: m[5], consistenza: m[6].replace(/m²|m2/, 'mq'), rendita: `€ ${m[7]}` });
  }
  for (const m of t.matchAll(RE_UNITA)) {
    const u = { foglio: m[1], particella: m[2], sub: m[3] || '', ...dettagliCatastali(t.slice(m.index + m[0].length, m.index + m[0].length + 220)) };
    // Particelle del solo terreno (es. «foglio 12 particella 345» senza sub né categoria) restano, ma dopo
    aggiungi(u);
  }
  // prima le unità più complete
  return unita.sort((a, b) => Number(Boolean(b.sub || b.categoria)) - Number(Boolean(a.sub || a.categoria))).slice(0, 8);
}

function comune(testo) {
  const m = piatto(testo).match(/comune\s+(?:censuario\s+)?di\s*:?\s*([A-ZÀ-Ü][A-Za-zÀ-ü'’ ]{2,40}?)(?=\s*(?:\(|,|\.|;|\bal\b|\bfoglio|\bprov|\bcodice|\bsezione|\bcatasto|\bvia\b|$))/i);
  return m ? maiuscole(m[1].trim()) : '';
}

// ---------------------------------------------------------------- indirizzo
const RE_VIA = /\b((?:via|viale|piazza|piazzale|località|loc\.|corso|vicolo|strada|largo|borgo|frazione)\s+[A-Za-zÀ-ü0-9'’. ]{2,50}?)\s*,?\s*(?:n\.?|n°|nc\.?|civico|civ\.)?\s*(\d{1,4}\s*(?:\/\s*[A-Za-z]|[A-Za-z]\b)?)\b/gi;

function indirizzo(testo, escludi) {
  const t = piatto(testo);
  let migliore = null;
  for (const m of t.matchAll(RE_VIA)) {
    const via = `${maiuscole(m[1].trim())} ${m[2].replace(/\s+/g, '').toUpperCase()}`;
    if (escludi.some((e) => e && via.toLowerCase().includes(e))) continue;
    const prima = t.slice(Math.max(0, m.index - 60), m.index).toLowerCase();
    let punti = 0;
    if (/sit[oa]|ubicat|post[oa]\s+in|immobile|fabbricato|unit[àa]|appartamento|edificio|in\s*$/.test(prima)) punti += 2;
    if (/indirizzo/.test(prima)) punti += 2;
    if (/resident|domicil|sede|nat[oa]\s|studio|c\.f\.|codice fiscale/.test(prima.slice(-30))) punti -= 4;
    if (!migliore || punti > migliore.punti) migliore = { via, punti };
  }
  return migliore && migliore.punti >= 0 ? migliore.via : '';
}

// ---------------------------------------------------------------- urbanistica
const RE_TITOLO = /\b(licenza\s+(?:edilizia|di\s+costruzione)|nulla\s+osta|concessione\s+edilizia(?:\s+in\s+sanatoria)?|concessione\s+in\s+sanatoria|condono\s+edilizio|autorizzazione\s+edilizia|permesso\s+di\s+costruire(?:\s+in\s+sanatoria)?|attestazione\s+di\s+conformit[àa]\s+in\s+sanatoria|D\.?\s?I\.?\s?A\.?|S\.?\s?C\.?\s?I\.?\s?A\.?|C\.?\s?I\.?\s?L\.?\s?A\.?|C\.?\s?I\.?\s?L\.?|(?:certificato\s+di\s+|attestazione\s+di\s+)?(?:abitabilit[àa]|agibilit[àa]))\s*(?:n\.?|n°|nr\.?|numero|prot\.?)\s*([\w/.-]{1,15})(?:[^\d]{0,30}?(?:del|in\s+data|rilasciat\w+\s+il)\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}))?/gi;

function titoli(testo) {
  const out = [];
  for (const m of piatto(testo).matchAll(RE_TITOLO)) {
    const nome = /^[A-Z.\s]+$/.test(m[1]) ? m[1].replace(/[.\s]/g, '').toUpperCase() : m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase().replace(/\s+/g, ' ');
    const voce = `${nome} n. ${m[2].replace(/[.,]$/, '')}${m[3] ? ` del ${m[3]}` : ''}`;
    if (!out.some((x) => x.toLowerCase() === voce.toLowerCase())) out.push(voce);
  }
  return out.slice(0, 10);
}

function esitoRelazione(testo) {
  const t = piatto(testo).toLowerCase();
  if (/non\s+(?:sono\s+(?:state\s+)?)?(?:rilevat\w+|riscontrat\w+|present\w+|emers\w+)\s+(?:alcuna\s+|delle\s+)?difformit/.test(t)) return 'conforme';
  if (/non\s+(?:è|e'|risulta|risultano|sono)\s+conform|difformit[àa]\s+(?:rilevat|riscontrat|da\s+regolarizz|non\s+sanabil)|(?:si\s+)?(?:rilevano|riscontrano|sono\s+state\s+rilevate)\s+(?:le\s+seguenti\s+|alcune\s+|delle\s+)?difformit/.test(t)) return 'difforme';
  if (/(?:è|e'|risulta|risultano|sono)\s+(?:urbanisticamente\s+)?conform|conformit[àa]\s+(?:urbanistica|edilizia)\s+(?:dell|del|degli)|stato\s+legittimo\s+(?:dell|del|è|risulta)/.test(t)) return 'conforme';
  return '';
}

// ---------------------------------------------------------------- APE
function ape(testo) {
  const t = piatto(testo);
  const c = t.match(/(?:classe|CLASSE|Classe)\s+(?:energetica|ENERGETICA|Energetica)(?:\s+(?:globale|GLOBALE))?(?:\s+dell['’]\s*(?:edificio|immobile|unit\w+))?[\s:]*(A4|A3|A2|A1|[B-G])\b/);
  const ep = t.match(/EP\s*gl\s*,?\s*nren[^\d]{0,25}(\d+(?:[.,]\d+)?)/i);
  const val = t.match(/valid[oa]\s+fino\s+a[l]?\s*[:\s]*(\d{1,2}[/.-]\d{1,2}[/.-]\d{4})/i);
  const em = t.match(/data\s+(?:di\s+)?(?:emissione|rilascio)\s*[:\s]*(\d{1,2}[/.-]\d{1,2}[/.-]\d{4})/i);
  const cod = t.match(/codice\s+(?:identificativo|certificato|APE)\s*[:\s]*([A-Z0-9][\w/.-]{5,40})/i);
  let scadenza = val ? isoData(val[1]) : '';
  if (!scadenza && em && isoData(em[1])) { const [a, m, g] = isoData(em[1]).split('-'); scadenza = `${Number(a) + 10}-${m}-${g}`; }
  return { classe: c ? c[1] : '', ep: ep ? ep[1].replace('.', ',') : '', scadenza: scadenza || '', codice: cod ? cod[1] : '' };
}

// ---------------------------------------------------------------- descrizione
const CATEGORIE = {
  'A/1': 'Abitazione di tipo signorile', 'A/2': 'Abitazione di tipo civile', 'A/3': 'Abitazione di tipo economico',
  'A/4': 'Abitazione di tipo popolare', 'A/5': 'Abitazione di tipo ultrapopolare', 'A/6': 'Abitazione di tipo rurale',
  'A/7': 'Abitazione in villino', 'A/8': 'Abitazione in villa', 'A/9': 'Castello o palazzo di pregio', 'A/10': 'Ufficio o studio privato',
  'A/11': 'Abitazione tipica dei luoghi', 'C/1': 'Negozio o bottega', 'C/2': 'Magazzino o locale di deposito', 'C/3': 'Laboratorio artigianale',
  'C/6': 'Autorimessa o posto auto', 'C/7': 'Tettoia', 'D/1': 'Opificio', 'D/7': 'Fabbricato produttivo', 'D/8': 'Fabbricato commerciale',
  'D/10': 'Fabbricato rurale strumentale', 'F/2': 'Unità collabente', 'F/3': 'Unità in corso di costruzione', 'F/4': 'Unità in corso di definizione',
};

function descrizione(testo) {
  const t = spazi(testo);
  const m = t.match(/descrizione\s+(?:sintetica\s+)?(?:dell['’]\s*|del\s+|della\s+|degli\s+)?(?:immobil\w|unit[àa]|fabbricat\w|edifici\w|appartament\w|stato\s+(?:dei\s+luoghi|attuale))[^\n]{0,40}\n?/i);
  if (!m) return '';
  // righe successive fino al prossimo titolo (riga tutta in maiuscolo, es. «3. STATO LEGITTIMO»)
  const righe = [];
  for (const r of t.slice(m.index + m[0].length).split('\n')) {
    if (righe.length && /[A-ZÀ-Ü]{4,}/.test(r) && !/[a-zà-ü]/.test(r)) break;
    if (r.trim()) righe.push(r.trim());
    if (righe.join(' ').length > 900) break;
  }
  let corpo = righe.join(' ');
  if (corpo.length > 700) corpo = corpo.slice(0, 700).replace(/[^.]*$/, '') || corpo.slice(0, 700) + '…';
  return corpo.trim();
}

// ---------------------------------------------------------------- raccolta
const cache = new Map();

async function documenti(lavoro) {
  const elenco = await pratiche.conDocumenti(lavoro, { soloVisibili: false });
  const voci = [];
  for (const p of elenco) {
    const nomi = new Set(p.file.map((f) => f.percorso.toLowerCase()));
    for (const f of p.file) {
      if (!/\.pdf(\.p7m)?$/i.test(f.percorso)) continue;
      const firmato = /\.p7m$/i.test(f.percorso);
      // «Relazione.pdf» e «Relazione.pdf.p7m»: si legge il PDF semplice, ricordando che è firmato
      if (firmato && nomi.has(f.percorso.slice(0, -4).toLowerCase())) continue;
      const tipo = tipoFile(f.percorso.split('/').pop(), p.cartella);
      if (!tipo) continue;
      const abs = archivio.fileDocumento(lavoro, p.cartella, f.percorso);
      if (!abs) continue;
      const st = fs.statSync(abs);
      if (st.size > MAX_BYTE) continue;
      const conFirma = firmato || nomi.has(`${f.percorso.toLowerCase()}.p7m`);
      voci.push({ tipo, abs, pratica: p, nome: f.percorso.split('/').pop(), firmato: conFirma, firma: `${abs}:${st.size}:${st.mtimeMs}:${conFirma}:${p.stato}` });
    }
  }
  return voci.sort((a, b) => PRIORITA[a.tipo] - PRIORITA[b.tipo]).slice(0, MAX_FILE);
}

/** Dati letti dai documenti: { indirizzo, comune, catasto[], urbanistica, ape, descrizione, fonti[] }. */
async function leggiDocumenti(lavoro) {
  const voci = await documenti(lavoro);
  const firma = voci.map((v) => v.firma).join('|');
  const c = cache.get(lavoro.id);
  if (c && c.firma === firma) return c.dati;

  const escludi = [String(config.studio.indirizzo || '').toLowerCase().split(/[–,-]/)[0].trim().replace(/\s+\d+.*$/, '')];
  const dati = { indirizzo: '', comune: '', catasto: [], urbanistica: null, ape: { classe: '', ep: '', scadenza: '', codice: '' }, descrizione: '', fonti: [] };
  for (const v of voci) {
    let testo = '';
    try { testo = await leggiTesto(v.abs, PAGINE[v.tipo]); } catch { continue; }
    if (!testo || testo.replace(/\s/g, '').length < 40) continue;
    let usato = false;
    if (v.tipo === 'relazione' && !dati.urbanistica && /conformit|stato\s+legittimo|titol\w+\s+(?:edilizi|abilitativ)|precedenti\s+edilizi/i.test(testo)) {
      // Relazione conclusa: firmata digitalmente, o nella pratica completata, o indicata come definitiva/firmata nel nome
      const conclusa = v.firmato || /complet/i.test(v.pratica.stato || '') || /firmat|definitiv/i.test(v.nome);
      dati.urbanistica = { conclusa, esito: conclusa ? esitoRelazione(testo) : '', titoli: titoli(testo), fonte: v.nome, data: v.pratica.data || '' };
      dati.descrizione = dati.descrizione || descrizione(testo);
      usato = true;
    }
    if (v.tipo === 'ape' || (!dati.ape.classe && /prestazione\s+energetica/i.test(testo))) {
      const a = ape(testo);
      if (a.classe && !dati.ape.classe) { dati.ape = a; usato = true; }
    }
    const unita = catasto(testo);
    if (unita.length && (v.tipo !== 'relazione' || !dati.catasto.length)) {
      for (const u of unita) {
        const gia = dati.catasto.find((x) => x.foglio === u.foglio && x.particella === u.particella && (x.sub || '') === (u.sub || ''));
        if (!gia) dati.catasto.push(u);
        else for (const k of ['categoria', 'classe', 'consistenza', 'rendita']) gia[k] = gia[k] || u[k];
      }
      usato = true;
    }
    if (!dati.comune) { dati.comune = comune(testo); usato = usato || Boolean(dati.comune); }
    if (!dati.indirizzo && v.tipo !== 'ape') { dati.indirizzo = indirizzo(testo, escludi); usato = usato || Boolean(dati.indirizzo); }
    if (usato) dati.fonti.push(v.nome);
  }
  dati.catasto = dati.catasto.sort((a, b) => Number(Boolean(b.sub || b.categoria)) - Number(Boolean(a.sub || a.categoria))).slice(0, 8);
  cache.set(lavoro.id, { firma, dati });
  return dati;
}

const URB_AUTO = {
  conforme: { testo: 'Conforme (da relazione tecnica)', tono: 'ok' },
  difforme: { testo: 'Difformità rilevate (vedi relazione tecnica)', tono: 'ko' },
  valutazione: { testo: 'In fase di valutazione', tono: 'attesa' },
};

/**
 * Dati finali del fascicolo: prima quelli scritti dallo studio nella scheda, poi quelli letti dai documenti.
 * «elencoPratiche» sono le pratiche del lavoro (per sanatorie, APE e accesso atti).
 */
async function fascicolo(lavoro, elencoPratiche, formattaData) {
  const s = scheda.leggi(lavoro);
  const d = await leggiDocumenti(lavoro);
  const sch = scheda.righe(lavoro, elencoPratiche, formattaData);

  const cartellaVia = (lavoro.cartella || '').split(' - ').slice(1).join(' - ');
  const ind = s.indirizzo || lavoro.indirizzo || d.indirizzo || (RE_VIA.test(cartellaVia) ? cartellaVia : '');
  RE_VIA.lastIndex = 0;
  const com = s.comune || d.comune;

  // Urbanistica: la scelta dello studio prevale; poi la relazione (se conclusa); altrimenti «in fase di valutazione»
  let urb;
  const sanatoria = sch.righe.find((r) => r.voce === 'Conformità urbanistica');
  if (s.urbanistica !== 'da-verificare') urb = { testo: sanatoria.testo, tono: sanatoria.tono, nota: '' };
  else if (d.urbanistica && d.urbanistica.conclusa && d.urbanistica.esito) urb = { ...URB_AUTO[d.urbanistica.esito], nota: '' };
  else if (/sanatori/i.test(sanatoria.testo)) urb = { testo: sanatoria.testo, tono: 'attesa', nota: '' };
  else urb = { ...URB_AUTO.valutazione, nota: d.urbanistica ? 'La relazione tecnica di conformità è in corso di redazione.' : 'La verifica di conformità non è ancora stata completata.' };

  const apeD = { classe: s.apeClasse || d.ape.classe, ep: d.ape.ep, scadenza: s.apeScadenza || d.ape.scadenza, codice: d.ape.codice };
  if (!apeD.scadenza) { const r = sch.righe.find((x) => x.voce === 'APE'); if (r && /valido fino/.test(r.testo)) apeD.testoScheda = r.testo; }

  const catastoTesto = s.catasto;
  const unita = catastoTesto ? [] : d.catasto;
  let descr = s.descrizione || d.descrizione || lavoro.descrizione || '';
  if (!descr && unita.length && unita[0].categoria && CATEGORIE[unita[0].categoria]) {
    const u = unita[0];
    descr = `${CATEGORIE[u.categoria]}${u.consistenza ? ` di ${u.consistenza}` : ''}${ind ? `, posta in ${ind}` : ''}${com ? ` nel Comune di ${com}` : ''}.`;
  }

  const coord = s.coordinate;
  const query = coord || [ind, com].filter(Boolean).join(', ');
  return {
    titolo: lavoro.titolo, codice: lavoro.codice,
    indirizzo: ind, comune: com, coordinate: coord,
    mappa: query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : '',
    catasto: unita, catastoTesto,
    catastale: sch.righe.find((r) => r.voce === 'Conformità catastale'),
    urbanistica: { ...urb, titoli: d.urbanistica ? d.urbanistica.titoli : [], fonte: d.urbanistica && d.urbanistica.conclusa ? d.urbanistica.fonte : '' },
    ape: apeD, descrizione: descr,
    pratiche: sch.righe.filter((r) => r.voce === 'Accesso atti'),
    nota: s.nota, fonti: d.fonti,
    allegati: tipologieFonti(d.fonti),
  };
}

/** Solo la tipologia dei documenti usati e quanti sono: mai i nomi dei file. */
function tipologieFonti(fonti) {
  const categorie = [
    ['Visure e planimetrie catastali', /visur|planimetr|catast|docfa|pregeo/i],
    ['Relazione tecnica', /relazion/i],
    ['Attestato di prestazione energetica', /\bape\b|attestat|prestazione/i],
    ['Titoli edilizi e pratiche comunali', /scia|cila|permesso|sanatori|agibil|titolo|comunicazion/i],
  ];
  const out = [];
  for (const [voce, re] of categorie) {
    const n = (fonti || []).filter((nome) => re.test(String(nome))).length;
    if (n) out.push({ voce, testo: `${n} ${n === 1 ? 'documento' : 'documenti'} letti per ricavare i dati del fascicolo` });
  }
  return out;
}

module.exports = { leggiDocumenti, fascicolo, catasto, comune, indirizzo, titoli, esitoRelazione, ape, descrizione, pdfDaP7m, tipoFile, CATEGORIE };
