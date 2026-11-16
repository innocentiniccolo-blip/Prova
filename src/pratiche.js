'use strict';
/**
 * Pratiche di un lavoro.
 *
 * Ogni sottocartella del lavoro sul NAS è una pratica. Le cartelle nuove vengono
 * registrate da sole: quelle con un nome riconosciuto (config/studio.json →
 * pratiche.tipi, es. "CILA", "Accesso atti") sono visibili al cliente se
 * "visibiliDiDefault" è true (di serie è false: ogni nuova cartella nasce privata e lo studio
 * sceglie quali mostrare al cliente).
 */
const config = require('./config');
const pubblicati = require('./pubblicati');
const archivio = require('./archivio');
const { Pratiche } = require('./modelli');

const opzioni = config.studio.pratiche;

/** Nome mostrato al cliente: senza la numerazione iniziale ("006 - SCIA" → "SCIA"). */
function nomeVisibile(cartella) {
  let nome = cartella.replace(/^\s*\d+\s*[-–._)]\s*/, '').trim() || cartella;
  for (const t of archivio.tipiPratica) {
    if (t.length <= 5 && t === t.toUpperCase()) nome = nome.replace(new RegExp(`(^|[^A-Za-z])${t}(?=$|[^A-Za-z])`, 'i'), `$1${t}`);
  }
  return nome;
}

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
    // Ordine delle cartelle sul NAS (rispetta la numerazione dello studio, es. "001 - Rilievo")
    .sort((a, b) => a.cartella.localeCompare(b.cartella, 'it', { numeric: true }))
    .map((p) => ({ ...p, nome: nomeVisibile(p.cartella) }));
}

/** Pratiche con l'elenco dei documenti. Per il cliente solo quelle visibili ed esistenti. */
async function conDocumenti(lavoro, { soloVisibili = false, ruolo = 'proprietario' } = {}) {
  let elenco = await sincronizza(lavoro);
  // Per il cliente "visibile" è la visibilità del suo ruolo (proprietario, agenzia, impresa)
  if (soloVisibili) elenco = elenco.map((p) => require('./ruoli').perRuolo(p, ruolo)).filter((p) => p.visibile && p.esiste);
  for (const p of elenco) {
    const file = p.esiste ? pubblicati.annota(p, await archivio.documentiPratica(lavoro, p.cartella)) : [];
    // Il cliente vede solo i documenti pubblicati uno per uno dallo studio
    if (soloVisibili) {
      const visibili = file.filter((f) => f.pubblicato);
      const percorsi = new Set(visibili.map((f) => f.percorso.toLowerCase()));
      // «Tavola.pdf.p7m» accanto a «Tavola.pdf»: al cliente basta il PDF, che apre senza programmi di firma
      p.file = visibili.filter((f) => !(/\.p7m$/i.test(f.percorso) && percorsi.has(f.percorso.slice(0, -4).toLowerCase())));
    } else p.file = file;
  }
  return elenco;
}

/** Frase di stato per il cliente, es. "Presentata il 28/10/2026". */
function descriviStato(p, formattaData) {
  return p.data ? `${p.stato} il ${formattaData(p.data)}` : p.stato;
}

module.exports = { sincronizza, conDocumenti, descriviStato, nomeVisibile };
