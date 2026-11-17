'use strict';
/** Tappe delle pratiche (integrazioni, inizio e fine lavori): nomi, stati delle proposte e raggruppamento. */
const FASI = {
  integrazione: { nome: 'Integrazione', stato: 'Integrazione presentata' },
  inizio: { nome: 'Inizio lavori', stato: 'Inizio lavori comunicato' },
  fine: { nome: 'Fine lavori', stato: 'Fine lavori comunicata' },
};
const STATI = Object.fromEntries(Object.entries(FASI).map(([k, v]) => [v.stato, k]));

/** Fase indicata dal nome delle cartelle in cui sta il file (es. «Integrazione L.13-89/ricevuta.pdf»). */
function faseCartella(rel) {
  const cartelle = String(rel).split(/[\\/]/).slice(0, -1).join(' / ');
  if (/fine\s*(dei\s*)?lavori|ultimazione|regolare\s*esecuzione|\bD\.?R\.?E\b/i.test(cartelle)) return 'fine';
  if (/inizio\s*(dei\s*)?lavori|avvio\s*lavori/i.test(cartelle)) return 'inizio';
  if (/integrazion/i.test(cartelle)) return 'integrazione';
  return null;
}

/** { praticaId: [tappe] } da un elenco di righe pratiche_tappe. */
function perPratica(righe) {
  const out = {};
  for (const t of righe) (out[t.pratica_id] = out[t.pratica_id] || []).push({ ...t, nome: FASI[t.fase] ? FASI[t.fase].nome : t.fase });
  return out;
}

module.exports = { FASI, STATI, faseCartella, perPratica };
