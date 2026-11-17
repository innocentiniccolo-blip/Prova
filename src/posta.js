'use strict';
/** Invio email tramite la casella dello studio (SMTP). */
const nodemailer = require('nodemailer');
const config = require('./config');

const { posta } = config;
// In produzione serve anche URL_PUBBLICO, altrimenti i link nelle email non funzionerebbero
// Versione di prova: senza server di posta, le email vengono salvate come file di testo in questa cartella
const cartellaProva = !posta.host && process.env.POSTA_CARTELLA ? require('node:path').resolve(process.env.POSTA_CARTELLA) : '';
const attiva = Boolean(cartellaProva) || Boolean(posta.host && posta.mittente && (config.urlPubblico || !config.produzione));
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
  if (cartellaProva) {
    const fs = require('node:fs');
    fs.mkdirSync(cartellaProva, { recursive: true });
    const quando = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const nome = `${quando} - ${a.replace(/[^a-z0-9@.]+/gi, '_')} - ${oggetto.replace(/[^\p{L}\p{N} ]+/gu, ' ').slice(0, 60).trim()}.txt`;
    fs.writeFileSync(require('node:path').join(cartellaProva, nome), `A: ${a}\r\nOggetto: ${oggetto}\r\n\r\n${(testo + firma).replace(/\n/g, '\r\n')}\r\n`);
    return true;
  }
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

// Casella amministrazione: serve SMTP_AMM_USER e SMTP_AMM_PASS nel file .env
const amm = posta.amministrazione;
const ammAttiva = Boolean(posta.host && amm.user && amm.pass && amm.mittente);
const trasportoAmm = ammAttiva
  ? nodemailer.createTransport({ host: posta.host, port: posta.port, secure: posta.port === 465, auth: { user: amm.user, pass: amm.pass } })
  : null;

/** Invia un'email dalla casella amministrazione, con allegati (es. la notula in PDF). */
async function inviaAmministrazione({ a, oggetto, testo, allegati = [] }) {
  if (!ammAttiva) throw new Error('Casella amministrazione non configurata');
  const firma = `\n\n--\n${config.studio.nome}\nAmministrazione\n${config.studio.indirizzo}\nCell. ${config.studio.telefono}`;
  await trasportoAmm.sendMail({
    from: `"${config.studio.nome} - Amministrazione" <${amm.mittente}>`,
    to: a,
    replyTo: amm.mittente,
    subject: oggetto,
    text: testo + firma,
    attachments: allegati,
  });
  return true;
}

module.exports = { attiva, invia, ammAttiva, inviaAmministrazione };
