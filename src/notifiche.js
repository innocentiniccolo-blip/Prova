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

const db = require('./db');
const qAdmin = db.prepare("SELECT email FROM utenti WHERE ruolo = 'admin' AND attivo = 1");
const qUtente = db.prepare('SELECT nome, ruolo, attivo FROM utenti WHERE email = ?');
let avvisiInviati = []; // orari degli ultimi avvisi: al massimo 10 email all'ora

/**
 * Segnala allo studio che un accesso è stato bloccato per troppi errori.
 * Non blocca né fa fallire la richiesta: gli errori di invio finiscono solo nel registro.
 */
function avvisaBlocco(req, { email, perIp = false, dove = 'accesso' }) {
  const ora = Date.now();
  avvisiInviati = avvisiInviati.filter((t) => ora - t < 60 * 60 * 1000);
  console.warn(`[sicurezza] Blocco ${perIp ? 'indirizzo IP' : 'accesso'}: ${email || '-'} da ${req.ip} (${dove})`);
  if (avvisiInviati.length >= 10) return;
  avvisiInviati.push(ora);
  const ultimo = avvisiInviati.length === 10;
  const u = email && !perIp ? qUtente.get(String(email).trim().toLowerCase()) : null;
  const chi = perIp ? 'molte email diverse'
    : u ? `${email} (${u.ruolo === 'admin' ? 'account dello studio' : 'cliente: ' + u.nome}${u.attivo ? '' : ', disattivato'})`
    : `${email} (nessun account con questa email)`;
  const quando = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'short' });
  const destinatari = qAdmin.all().map((r) => r.email);
  if (!destinatari.length && config.studio.email) destinatari.push(config.studio.email);
  const testo = `Un accesso all'area clienti è stato bloccato per un'ora dopo troppi errori.\n\n`
    + `Quando: ${quando}\nDove: ${dove === 'profilo' ? 'cambio password dal profilo' : 'pagina di accesso'}\n`
    + `Email usata: ${chi}\nIndirizzo IP: ${req.ip}\n`
    + `Limite superato: ${perIp ? 'troppi errori dallo stesso indirizzo IP' : 'password sbagliata 5 volte'}\n\n`
    + `Cosa significa: quasi sempre è qualcuno che ha dimenticato la password. Se è un tuo cliente può usare "Password dimenticata?" `
    + `oppure puoi sbloccarlo subito dal pannello dello studio (${baseUrl(req)}/studio, riquadro "Accessi bloccati").\n`
    + `Se invece non riconosci l'email o gli avvisi si ripetono, è un tentativo di indovinare una password: il blocco lo ferma, non devi fare altro.`
    + (ultimo ? `\n\nNota: per non riempirti la casella, per un'ora non invio altri avvisi di questo tipo. I blocchi restano elencati nel pannello.` : '');
  for (const a of destinatari) {
    posta.invia({ a, oggetto: `Accesso bloccato: ${perIp ? 'indirizzo ' + req.ip : email}`, testo })
      .catch((e) => console.error('Avviso di blocco non inviato:', e.message));
  }
}

/** Email allo studio (es. il cliente ha caricato dei documenti). Non fa mai fallire la richiesta. */
function avvisaStudio(oggetto, testo) {
  const destinatari = qAdmin.all().map((r) => r.email);
  if (!destinatari.length && config.studio.email) destinatari.push(config.studio.email);
  for (const a of destinatari) {
    posta.invia({ a, oggetto, testo }).catch((e) => console.error('Avviso allo studio non inviato:', e.message));
  }
}

module.exports = {
  avvisaStudio,
  avvisaBlocco, inviaBenvenuto, avvisaClienti, baseUrl };
