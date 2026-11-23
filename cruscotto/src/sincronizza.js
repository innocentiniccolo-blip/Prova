'use strict';
/** Controllo periodico della casella: scarica le mail nuove, le abbina alle pratiche e prepara le bozze. */
const config = require('./config');
const ai = require('./ai');
const posta = require('./posta');
const { abbina } = require('./abbina');
const { Clienti, Pratiche, Scadenze, Attivita, Email, Impostazioni } = require('./modelli');

const P = config.posta;
const BOZZE_PER_GIRO = 10;
let inCorso = null;
let timer = null;

const praticheAperte = () => Pratiche.tutte.all().filter((p) => !config.studio.pratiche.statiChiusi.includes(p.stato));

/** Prepara (o rigenera) la bozza di risposta per una mail salvata. */
async function preparaBozza(id, istruzioni = '') {
  const email = Email.perId.get(id);
  if (!email) return null;
  const pratica = email.pratica_id ? Pratiche.perId.get(email.pratica_id) : null;
  const r = await ai.generaRisposta({
    email,
    pratica,
    scadenze: pratica ? Scadenze.perPratica.all(pratica.id) : [],
    attivita: pratica ? Attivita.perPratica.all(pratica.id) : [],
    praticheCliente: !pratica && email.cliente_id ? praticheAperte().filter((p) => p.cliente_id === email.cliente_id) : [],
    istruzioni,
  });
  Email.salvaBozza.run({ id, bozza_oggetto: r.oggetto, bozza_testo: r.testo, riassunto: r.riassunto, serve_risposta: r.serve_risposta ? 1 : 0 });
  return r;
}

function daPreparare(email) {
  if (P.bozzeAutomatiche === 'no' || !ai.attiva()) return false;
  if (P.bozzeAutomatiche === 'tutte') return true;
  return Boolean(email.cliente_id || email.pratica_id);
}

async function eseguiControllo() {
  const { uidvalidity, messaggi } = await posta.scarica((uv) => Email.ultimoUid.get(uv)?.uid ?? null);
  const pratiche = praticheAperte();
  const nuove = [];
  const proprio = P.indirizzo.toLowerCase();
  for (const m of messaggi) {
    if (m.mittente_email === proprio) continue; // copie di mail inviate da noi stessi
    const mittente = m.rispondi_a || m.mittente_email;
    const cliente = (m.mittente_email && Clienti.perEmail.get(m.mittente_email)) || (m.rispondi_a && Clienti.perEmail.get(m.rispondi_a)) || null;
    const { cliente_id, pratica_id } = abbina({ mittente, oggetto: m.oggetto, testo: m.testo }, { cliente, pratiche });
    const r = Email.inserisci.run({ ...m, uidvalidity, cliente_id, pratica_id });
    if (r.changes) nuove.push({ id: Number(r.lastInsertRowid), cliente_id, pratica_id });
  }
  // Bozze automatiche: prima le nuove, poi eventuali arretrate (es. chiave AI aggiunta dopo)
  let fatte = 0;
  const coda = [...nuove.filter(daPreparare).map((e) => e.id)];
  if (P.bozzeAutomatiche !== 'no' && ai.attiva()) {
    for (const { id } of Email.senzaBozza.all(BOZZE_PER_GIRO)) {
      const e = Email.perId.get(id);
      if (!coda.includes(id) && daPreparare(e)) coda.push(id);
    }
  }
  for (const id of coda.slice(0, BOZZE_PER_GIRO)) {
    try { await preparaBozza(id); fatte++; } catch (e) { Email.erroreAi.run(e.message, id); }
  }
  return { nuove: nuove.length, bozze: fatte };
}

/** Controlla subito la casella (se un controllo è già in corso, aspetta quello). */
function controlla() {
  if (!P.attiva) return Promise.resolve({ nuove: 0, bozze: 0 });
  if (!inCorso) {
    inCorso = eseguiControllo()
      .then((r) => { Impostazioni.scrivi('posta_ultimo_controllo', new Date().toISOString()); Impostazioni.scrivi('posta_errore', null); return r; })
      .catch((e) => { Impostazioni.scrivi('posta_errore', e.message); console.error('[posta]', e.message); throw e; })
      .finally(() => { inCorso = null; });
  }
  return inCorso;
}

function stato() {
  return {
    attiva: P.attiva,
    indirizzo: P.indirizzo,
    minuti: P.minuti,
    inCorso: Boolean(inCorso),
    ultimoControllo: Impostazioni.leggi('posta_ultimo_controllo'),
    errore: Impostazioni.leggi('posta_errore'),
    daRispondere: Email.contaDaRispondere.get().n,
  };
}

/** Avvia il controllo automatico ogni N minuti (solo se la casella è configurata). */
function avvia() {
  if (!P.attiva || timer) return;
  const giro = () => controlla().catch(() => {});
  setTimeout(giro, 3000).unref();
  timer = setInterval(giro, P.minuti * 60_000);
  timer.unref();
}

module.exports = { controlla, preparaBozza, stato, avvia };
