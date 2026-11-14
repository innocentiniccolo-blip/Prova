'use strict';
/**
 * Pratiche di un lavoro.
 *
 * Ogni sottocartella del lavoro sul NAS è una pratica. Le cartelle nuove vengono
 * registrate da sole: quelle con un nome riconosciuto (config/studio.json →
 * pratiche.tipi, es. "CILA", "Accesso atti") sono visibili al cliente se
 * "visibiliDiDefault" è true; tutte le altre restano private finché lo studio
 * non le rende visibili dal pannello.
 */
const config = require('./config');
const archivio = require('./archivio');
const { Pratiche } = require('./modelli');

const opzioni = config.studio.pratiche;

/** Allinea il database alle sottocartelle presenti sul NAS e restituisce le pratiche ordinate. */
async function sincronizza(lavoro) {
  const cartelle = await archivio.sottocartelle(lavoro);
  const note = new Set(Pratiche.perLavoro.all(lavoro.id).map((p) => p.cartella));
  for (const c of cartelle) {
    if (note.has(c)) continue;
    const i = archivio.indiceTipo(c);
    const visibile = opzioni.visibiliDiDefault && i >= 0 ? 1 : 0;
    Pratiche.inserisci.run(lavoro.id, c, opzioni.stati[0], visibile, i >= 0 ? i : 100);
  }
  const presenti = new Set(cartelle);
  return Pratiche.perLavoro.all(lavoro.id)
    .map((p) => ({ ...p, esiste: presenti.has(p.cartella) }))
    .sort((a, b) => a.ordine - b.ordine || a.cartella.localeCompare(b.cartella, 'it', { numeric: true }));
}

/** Pratiche con l'elenco dei documenti. Per il cliente solo quelle visibili ed esistenti. */
async function conDocumenti(lavoro, { soloVisibili = false } = {}) {
  let elenco = await sincronizza(lavoro);
  if (soloVisibili) elenco = elenco.filter((p) => p.visibile && p.esiste);
  for (const p of elenco) p.file = p.esiste ? await archivio.documentiPratica(lavoro, p.cartella) : [];
  return elenco;
}

/** Frase di stato per il cliente, es. "Presentata il 28/10/2026". */
function descriviStato(p, formattaData) {
  return p.data ? `${p.stato} il ${formattaData(p.data)}` : p.stato;
}

module.exports = { sincronizza, conDocumenti, descriviStato };
