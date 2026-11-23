'use strict';
/**
 * Collegamento alla casella di posta (Aruba: IMAP imaps.aruba.it:993, SMTP smtps.aruba.it:465).
 * - La lettura usa BODY.PEEK: le mail NON vengono segnate come lette, Thunderbird le vede come prima.
 * - L'invio passa da SMTP e salva una copia nella cartella "Inviata"; la mail originale viene
 *   segnata come "risposta" (in Thunderbird compare la freccina).
 * - In alternativa la risposta si salva nella cartella "Bozze" e si spedisce da Thunderbird.
 */
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const config = require('./config');

const P = config.posta;
const MAX_TESTO = 100_000;
const MAX_PER_CONTROLLO = 200;

class ErrorePosta extends Error {}

function spiegaErrore(e) {
  if (e instanceof ErrorePosta) return e;
  if (e?.authenticationFailed || /auth/i.test(e?.responseText || '') || e?.code === 'EAUTH') {
    return new ErrorePosta('Accesso alla casella rifiutato: controlla indirizzo e password nel file .env.');
  }
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ESOCKET', 'NoConnection'].includes(e?.code)) {
    return new ErrorePosta('Server di posta non raggiungibile: controlla la connessione a internet.');
  }
  return new ErrorePosta(`Errore di posta: ${e?.message || e}`);
}

function nuovoClient() {
  return new ImapFlow({
    host: P.imap.host, port: P.imap.port, secure: P.imap.secure,
    auth: { user: P.indirizzo, pass: P.password },
    logger: false, connectionTimeout: 30_000, greetingTimeout: 20_000,
    tls: { rejectUnauthorized: P.imap.secure },
  });
}

async function conCasella(fn) {
  if (!P.attiva) throw new ErrorePosta('Casella di posta non configurata (EMAIL_INDIRIZZO e EMAIL_PASSWORD nel file .env).');
  const client = nuovoClient();
  client.on('error', () => {}); // gli errori di rete arrivano comunque come eccezioni
  try {
    await client.connect();
    return await fn(client);
  } catch (e) {
    throw spiegaErrore(e);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

const indirizzo = (lista) => lista?.value?.[0] || null;

async function analizza(uid, source) {
  const m = await simpleParser(source, { skipImageLinks: true });
  const da = indirizzo(m.from);
  const rispondiA = indirizzo(m.replyTo);
  let testo = m.text || '';
  if (!testo.trim() && m.html) testo = m.html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
  const refs = [].concat(m.references || []);
  return {
    uid,
    message_id: m.messageId || null,
    riferimenti: refs.length ? refs.join(' ') : null,
    mittente_nome: da?.name || null,
    mittente_email: (da?.address || '').toLowerCase() || null,
    rispondi_a: (rispondiA?.address || '').toLowerCase() || null,
    oggetto: m.subject || '',
    data: (m.date || new Date()).toISOString(),
    testo: testo.trim().slice(0, MAX_TESTO),
  };
}

/**
 * Scarica le mail nuove della posta in arrivo.
 * @param {(uidvalidity: number) => number|null} ultimoUid  ultimo UID già salvato per quella casella
 */
async function scarica(ultimoUid) {
  return conCasella(async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uidvalidity = Number(client.mailbox.uidValidity);
      const ultimo = ultimoUid(uidvalidity) || 0;
      const criterio = ultimo ? { uid: `${ultimo + 1}:*` } : { since: new Date(Date.now() - P.giorniIniziali * 86400000) };
      const uids = ((await client.search(criterio, { uid: true })) || []).filter((u) => u > ultimo).sort((a, b) => a - b).slice(-MAX_PER_CONTROLLO);
      const messaggi = [];
      if (uids.length) {
        for await (const msg of client.fetch(uids.join(','), { uid: true, source: true }, { uid: true })) {
          messaggi.push(await analizza(msg.uid, msg.source));
        }
      }
      return { uidvalidity, messaggi };
    } finally {
      lock.release();
    }
  });
}

/** Messaggio completo (RFC 822) pronto per l'invio o per le cartelle IMAP. */
async function componi({ a, oggetto, testo, inReplyTo, riferimenti }) {
  const refs = [...String(riferimenti || '').split(/\s+/).filter(Boolean), inReplyTo].filter(Boolean);
  const mail = new MailComposer({
    from: { name: P.nome, address: P.indirizzo },
    to: a,
    subject: oggetto,
    text: testo,
    inReplyTo: inReplyTo || undefined,
    references: refs.length ? refs : undefined,
    date: new Date(),
  });
  return mail.compile().build();
}

async function cartellaSpeciale(client, uso, nomi) {
  const lista = await client.list();
  return (lista.find((m) => m.specialUse === uso) || lista.find((m) => nomi.test(m.path)))?.path || null;
}
const NOMI_INVIATA = /^(INBOX[./])?(Sent|Sent Items|Sent Messages|Posta inviata|Inviata|Inviati)$/i;
const NOMI_BOZZE = /^(INBOX[./])?(Drafts|Bozze)$/i;

async function segnaOriginale(client, uidvalidity, uid) {
  if (!uid) return;
  const lock = await client.getMailboxLock('INBOX');
  try {
    if (Number(client.mailbox.uidValidity) === Number(uidvalidity)) await client.messageFlagsAdd(String(uid), ['\\Answered'], { uid: true });
  } finally { lock.release(); }
}

/** Invia la risposta via SMTP, ne salva copia in "Inviata" e segna l'originale come risposta. */
async function invia(dati, originale = {}) {
  if (!P.attiva) throw new ErrorePosta('Casella di posta non configurata.');
  const raw = await componi(dati);
  const trasporto = nodemailer.createTransport({
    host: P.smtp.host, port: P.smtp.port, secure: P.smtp.secure,
    auth: { user: P.indirizzo, pass: P.password },
    tls: { rejectUnauthorized: P.smtp.secure },
    connectionTimeout: 30_000,
  });
  try {
    await trasporto.sendMail({ envelope: { from: P.indirizzo, to: [dati.a] }, raw });
  } catch (e) {
    throw spiegaErrore(e);
  }
  // L'invio è avvenuto: copia e segno sono un di più, un loro errore non deve far credere che la mail non sia partita
  try {
    return await conCasella(async (client) => {
      const inviata = await cartellaSpeciale(client, '\\Sent', NOMI_INVIATA);
      if (inviata) await client.append(inviata, raw, ['\\Seen']);
      await segnaOriginale(client, originale.uidvalidity, originale.uid);
      return { copia: Boolean(inviata) };
    });
  } catch (e) {
    return { copia: false, avviso: e.message };
  }
}

/** Salva la risposta nella cartella "Bozze": la si ritrova in Thunderbird. */
async function salvaBozza(dati) {
  const raw = await componi(dati);
  return conCasella(async (client) => {
    const bozze = await cartellaSpeciale(client, '\\Drafts', NOMI_BOZZE);
    if (!bozze) throw new ErrorePosta('Non trovo la cartella Bozze nella casella.');
    await client.append(bozze, raw, ['\\Draft', '\\Seen']);
    return { cartella: bozze };
  });
}

module.exports = { scarica, invia, salvaBozza, ErrorePosta, analizza };
