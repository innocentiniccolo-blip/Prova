'use strict';
/**
 * Scheda immobile: in una riga se l'immobile è pronto per la vendita.
 * Parte dei dati la compila lo studio (conformità urbanistica e catastale, APE),
 * parte arriva da sola dalle pratiche (accesso atti, sanatorie, APE completato).
 */
const URBANISTICA = {
  'da-verificare': { testo: 'Da verificare', tono: 'neutro' },
  conforme: { testo: 'Conforme', tono: 'ok' },
  difforme: { testo: 'Difformità da regolarizzare', tono: 'ko' },
  sanatoria: { testo: 'Sanatoria / regolarizzazione in corso', tono: 'attesa' },
  regolarizzata: { testo: 'Regolarizzata', tono: 'ok' },
};
const CATASTALE = {
  'da-verificare': { testo: 'Da verificare', tono: 'neutro' },
  conforme: { testo: 'Planimetria conforme', tono: 'ok' },
  'da-aggiornare': { testo: 'Planimetria da aggiornare', tono: 'ko' },
  aggiornata: { testo: 'Aggiornata (DOCFA presentato)', tono: 'ok' },
};
const CLASSI_APE = ['A4', 'A3', 'A2', 'A1', 'B', 'C', 'D', 'E', 'F', 'G'];

function leggi(lavoro) {
  let s = {};
  try { s = JSON.parse(lavoro.scheda || '{}') || {}; } catch { s = {}; }
  return {
    attiva: Boolean(s.attiva), urbanistica: URBANISTICA[s.urbanistica] ? s.urbanistica : 'da-verificare',
    catastale: CATASTALE[s.catastale] ? s.catastale : 'da-verificare',
    apeClasse: CLASSI_APE.includes(s.apeClasse) ? s.apeClasse : '', apeScadenza: /^\d{4}-\d{2}-\d{2}$/.test(s.apeScadenza || '') ? s.apeScadenza : '',
    nota: String(s.nota || '').slice(0, 1000),
    // Dati del fascicolo del fabbricato: se vuoti si leggono dai documenti
    indirizzo: String(s.indirizzo || '').trim().slice(0, 150),
    comune: String(s.comune || '').trim().slice(0, 60),
    coordinate: /^-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+$/.test(String(s.coordinate || '').trim()) ? String(s.coordinate).replace(/\s+/g, '') : '',
    catasto: String(s.catasto || '').trim().slice(0, 800),
    descrizione: String(s.descrizione || '').trim().slice(0, 1500),
  };
}

function daModulo(body) {
  return JSON.stringify(leggi({ scheda: JSON.stringify({
    attiva: body.attiva === '1', urbanistica: body.urbanistica, catastale: body.catastale,
    apeClasse: body.apeClasse, apeScadenza: body.apeScadenza, nota: body.nota,
    indirizzo: body.indirizzo, comune: body.comune, coordinate: body.coordinate, catasto: body.catasto, descrizione: body.descrizione,
  }) }));
}

const trova = (pratiche, re) => pratiche.find((p) => re.test(p.cartella));
const aggiungiAnni = (iso, n) => { const [a, m, g] = iso.split('-'); return `${Number(a) + n}-${m}-${g}`; };

/** Righe della scheda pronte da mostrare: [{ voce, testo, tono }]. Le pratiche sono quelle del lavoro. */
function righe(lavoro, pratiche, formattaData) {
  const s = leggi(lavoro);
  const out = [];
  const sanatoria = trova(pratiche, /sanatori|regolarizz|cila\s+tardiva|accertamento/i);
  let urb = { ...URBANISTICA[s.urbanistica] };
  if (s.urbanistica === 'da-verificare' && sanatoria) urb = { ...URBANISTICA.sanatoria };
  if (sanatoria && sanatoria.data && /presentat|integraz/i.test(sanatoria.stato)) urb.testo += ` · presentata il ${formattaData(sanatoria.data)}${sanatoria.protocollo ? `, prot. ${sanatoria.protocollo}` : ''}`;
  out.push({ voce: 'Conformità urbanistica', ...urb });
  out.push({ voce: 'Conformità catastale', ...CATASTALE[s.catastale] });
  // APE: dalla scheda o, se manca, dalla pratica APE completata (validità 10 anni)
  const apeP = trova(pratiche, /\bape\b|attestat\w*\s+(di\s+)?prestazione/i);
  let scad = s.apeScadenza;
  if (!scad && apeP && apeP.data && /complet/i.test(apeP.stato)) scad = aggiungiAnni(apeP.data, 10);
  if (s.apeClasse || scad) {
    const scaduto = scad && scad < new Date().toISOString().slice(0, 10);
    out.push({ voce: 'APE', testo: `${s.apeClasse ? `Classe ${s.apeClasse}` : 'Presente'}${scad ? ` · valido fino al ${formattaData(scad)}` : ''}`, tono: scaduto ? 'ko' : 'ok' });
  } else out.push({ voce: 'APE', testo: apeP ? `In corso (${apeP.stato.toLowerCase()})` : 'Da fare', tono: apeP ? 'attesa' : 'neutro' });
  const acc = trova(pratiche, /accesso\s*(agli\s*)?atti/i);
  if (acc) {
    const fatto = /complet/i.test(acc.stato);
    out.push({ voce: 'Accesso atti', testo: `${acc.stato}${acc.data ? ` il ${formattaData(acc.data)}` : ''}`, tono: fatto ? 'ok' : 'attesa' });
  }
  return { attiva: s.attiva, nota: s.nota, righe: out, pronto: out.every((r) => r.tono === 'ok') };
}

module.exports = { URBANISTICA, CATASTALE, CLASSI_APE, leggi, daModulo, righe };
