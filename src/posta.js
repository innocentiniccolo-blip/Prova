'use strict';
/** Invio email tramite la casella dello studio (SMTP). */
const nodemailer = require('nodemailer');
const config = require('./config');

const { posta } = config;
// In produzione serve anche URL_PUBBLICO, altrimenti i link nelle email non funzionerebbero
const attiva = Boolean(posta.host && posta.mittente && (config.urlPubblico || !config.produzione));
if (posta.host && !attiva) console.warn('Email disattivate: imposta URL_PUBBLICO nel file .env');

const trasporto = attiva
  ? nodemailer.createTransport({
      host: posta.host,
      port: posta.port,
      secure: posta.port === 465,
      auth: posta.user ? { user: posta.user, pass: posta.pass } : undefined,
    })
  : null;

/** Invia un'email di solo testo. Senza SMTP configurato, in sviluppo la scrive nel terminale. */
async function invia({ a, oggetto, testo }) {
  const firma = `\n\n--\n${config.studio.nome}\n${config.studio.indirizzo}\nCell. ${config.studio.telefono}`
    + (config.urlPubblico ? `\nInformativa sulla privacy: ${config.urlPubblico}/privacy` : '');
  if (!attiva) {
    if (!config.produzione) console.log(`\n[email non inviata: SMTP non configurato]\nA: ${a}\nOggetto: ${oggetto}\n\n${testo}${firma}\n`);
    return false;
  }
  await trasporto.sendMail({
    from: `"${config.studio.nome}" <${posta.mittente}>`,
    to: a,
    subject: oggetto,
    text: testo + firma,
  });
  return true;
}

module.exports = { attiva, invia };
