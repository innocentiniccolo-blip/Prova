'use strict';
/** Email ai clienti: benvenuto e avvisi di aggiornamento. Usate dal pannello e dalle automazioni. */
const config = require('./config');
const posta = require('./posta');
const linkPassword = require('./link-password');
const { Lavori } = require('./modelli');

/** Indirizzo base dell'app per i link nelle email. */
function baseUrl(req) {
  if (config.urlPubblico) return config.urlPubblico;
  return req ? `${req.protocol}://${req.get('host')}` : `http://localhost:${config.port}`;
}
const finta = (req) => req || { protocol: 'http', get: () => `localhost:${config.port}` };

/** Email di benvenuto con il link per scegliere la password (valido 7 giorni). */
async function inviaBenvenuto(req, cliente) {
  const link = linkPassword.crea(cliente.id, 24 * 7, finta(req));
  return posta.invia({
    a: cliente.email,
    oggetto: `Il tuo accesso all'area clienti – ${config.studio.nomeBreve}`,
    testo: `Gentile ${cliente.nome},\n\nda oggi puoi seguire online le tue pratiche: a che punto sono, date di presentazione, numeri di protocollo e documenti.\n\nPer iniziare scegli la tua password da questo link (valido 7 giorni):\n${link}\n\nPoi accedi quando vuoi da ${baseUrl(req)} con questa email (${cliente.email}).\n\nPer qualsiasi dubbio sono a disposizione.`,
  });
}

/**
 * Avvisa via email i clienti attivi del lavoro. Non blocca mai il salvataggio:
 * restituisce quanti avvisi sono partiti e quanti sono falliti.
 */
async function avvisaClienti(req, lavoro, oggetto, corpo) {
  const esito = { inviati: 0, falliti: 0 };
  if (!posta.attiva || !lavoro.visibile) return esito;
  for (const c of Lavori.clienti.all(lavoro.id).filter((x) => x.attivo)) {
    try {
      await posta.invia({
        a: c.email,
        oggetto,
        testo: `Gentile ${c.nome},\n\n${corpo}\n\nPuoi vedere i dettagli e i documenti nella tua area clienti:\n${baseUrl(req)}/area/lavori/${lavoro.id}\n\nQuesta è un'email automatica: per domande rispondi pure o contattami.`,
      });
      esito.inviati++;
    } catch (err) {
      console.error(`Avviso email non inviato a ${c.email}:`, err.message);
      esito.falliti++;
    }
  }
  return esito;
}

module.exports = { inviaBenvenuto, avvisaClienti, baseUrl };
