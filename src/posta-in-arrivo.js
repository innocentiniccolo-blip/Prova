'use strict';
/**
 * Lettura automatica delle risposte delle imprese ai promemoria (casella info@, IMAP).
 *
 * Ogni 5 minuti guarda SOLO le email degli ultimi 30 giorni con il codice del promemoria nell'oggetto
 * (es. "[Rif. IMP-12-a3f9c1]"). La casella si apre in sola lettura: niente viene cancellato,
 * spostato o segnato come letto. Un messaggio viene preso in considerazione solo se:
 *  - il codice è valido (firmato: non si può inventare quello di un'altra impresa);
 *  - il mittente è l'email o la PEC registrata per quell'impresa.
 * Gli allegati PDF, JPG e PNG vanno in "Da controllare" nella scheda dell'impresa (vedi arrivi.js).
 * Le PEC arrivano "imbustate": si legge il messaggio originale contenuto in postacert.eml.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('./config');
const db = require('./db');
const arrivi = require('./arrivi');
const imprese = require('./imprese');

const p = config.posta;
const imap = {
  host: process.env.IMAP_HOST || (/aruba\.it$/i.test(p.host) ? 'imaps.aruba.it' : ''),
  port: Number(process.env.IMAP_PORT) || 993,
  user: process.env.IMAP_USER || p.user,
  pass: process.env.IMAP_PASS || p.pass,
};
const attiva = Boolean(imap.host && imap.user && imap.pass) && process.env.LEGGI_RISPOSTE !== 'false';
const MAX_MESSAGGIO = 30 * 1024 * 1024;
const IMMAGINE_MINIMA = 20 * 1024; // sotto questa dimensione le immagini sono loghi delle firme, non documenti

db.exec(`CREATE TABLE IF NOT EXISTS posta_letta (
  uidvalidity TEXT NOT NULL,
  uid         INTEGER NOT NULL,
  esito       TEXT,
  letto_il    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (uidvalidity, uid)
)`);
const Q = {
  letto: db.prepare('SELECT 1 FROM posta_letta WHERE uidvalidity = ? AND uid = ?'),
  segna: db.prepare('INSERT OR IGNORE INTO posta_letta (uidvalidity, uid, esito) VALUES (?, ?, ?)'),
  pulisci: db.prepare("DELETE FROM posta_letta WHERE letto_il < datetime('now', '-60 days')"),
};

const indirizzo = (campo) => String(campo?.value?.[0]?.address || '').trim().toLowerCase();

/** Se è una PEC, restituisce il messaggio originale (postacert.eml) già letto; altrimenti il messaggio stesso. */
async function originale(msg) {
  const { simpleParser } = require('mailparser');
  const busta = (msg.attachments || []).find((a) => /^postacert\.eml$/i.test(a.filename || '') || a.contentType === 'message/rfc822');
  if (!busta) return msg;
  try { return await simpleParser(busta.content); } catch { return msg; }
}

function allegatoUtile(a) {
  const ext = path.extname(a.filename || '').toLowerCase();
  if (!arrivi.ESTENSIONI.includes(ext)) return false;
  if (ext !== '.pdf' && (a.related || a.contentDisposition === 'inline' || a.size < IMMAGINE_MINIMA)) return false;
  return true;
}

/**
 * Elabora un messaggio già letto (oggetto di mailparser). Restituisce un riassunto:
 * { esito: 'ignorato' | 'mittente-diverso' | 'senza-allegati' | 'ricevuto', impresa, salvati, rifiutati }
 */
/** true se i controlli del provider di posta (SPF/DMARC) dicono che il mittente è falsificato. */
function mittenteFalsificato(m) {
  const h = m.headers && m.headers.get('authentication-results');
  const righe = (Array.isArray(h) ? h : [h]).filter(Boolean).map((x) => (typeof x === 'string' ? x : x.value || JSON.stringify(x)).toLowerCase());
  return righe.some((r) => /\b(dmarc|spf)=fail\b/.test(r));
}

async function elabora(messaggio) {
  if (mittenteFalsificato(messaggio)) {
    console.warn(`Posta: messaggio «${String(messaggio.subject || '').slice(0, 80)}» scartato (SPF/DMARC: mittente non autentico)`);
    return { esito: 'mittente-falsificato' };
  }
  const msg = await originale(messaggio);
  const impresaId = arrivi.leggiRiferimento(msg.subject) || arrivi.leggiRiferimento(messaggio.subject);
  const impresa = impresaId && imprese.Q.perId.get(impresaId);
  if (!impresa) return { esito: 'ignorato' };
  const da = indirizzo(msg.from);
  const ammessi = [impresa.email, impresa.pec].filter(Boolean).map((x) => x.trim().toLowerCase());
  if (!da || !ammessi.includes(da)) {
    console.warn(`Posta: risposta al promemoria di ${impresa.ragione_sociale} da un mittente non registrato (${da || 'sconosciuto'}): ignorata`);
    return { esito: 'mittente-diverso', impresa, da };
  }
  const allegati = (msg.attachments || []).filter(allegatoUtile);
  if (!allegati.length) return { esito: 'senza-allegati', impresa };
  const out = { esito: 'ricevuto', impresa, da, salvati: [], rifiutati: [], infetti: [] };
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'posta-'));
  try {
    for (const [i, a] of allegati.entries()) {
      const tmp = path.join(dir, String(i));
      await fsp.writeFile(tmp, a.content);
      const r = await arrivi.ricevi(impresa.id, { percorso: tmp, nome: a.filename, dimensione: a.content.length }, { origine: 'email', mittente: da });
      if (r.ok) out.salvati.push(r.nome);
      else (r.infetto ? out.infetti : out.rifiutati).push({ nome: a.filename, motivo: r.motivo, dettaglio: r.dettaglio });
    }
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
  return out;
}

function avvisa(r) {
  const notifiche = require('./notifiche');
  const base = config.urlPubblico || '';
  if (r.salvati?.length) {
    notifiche.avvisaStudio(`Documenti da ${r.impresa.ragione_sociale} (email)`,
      `${r.impresa.ragione_sociale} ha risposto al promemoria (${r.da}) con:\n\n${r.salvati.map((n) => `- ${n}`).join('\n')}`
      + (r.rifiutati.length ? `\n\nNon presi (tipo non ammesso o troppo grandi):\n${r.rifiutati.map((x) => `- ${x.nome}: ${x.motivo}`).join('\n')}` : '')
      + `\n\nLi trovi da controllare nella scheda dell'impresa: ${base}/studio/imprese/${r.impresa.id}#arrivi`);
  }
  if (r.infetti?.length) {
    notifiche.avvisaStudio(`Antivirus: allegato scartato da ${r.impresa.ragione_sociale}`,
      `Nella risposta di ${r.impresa.ragione_sociale} (${r.da}) l'antivirus ha trovato una minaccia:\n\n${r.infetti.map((x) => `- ${x.nome}: ${x.dettaglio}`).join('\n')}\n\nIl file non è stato salvato. Non aprire quell'allegato dalla tua casella di posta.`);
  }
}

/** Controlla la casella una volta. Restituisce il numero di file arrivati. */
async function controlla() {
  if (!attiva) return 0;
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const client = new ImapFlow({ host: imap.host, port: imap.port, secure: imap.port === 993, auth: { user: imap.user, pass: imap.pass }, logger: false });
  let nuovi = 0;
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const uv = String(client.mailbox.uidValidity);
      const dal = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const uids = await client.search({ since: dal, subject: 'IMP-' }, { uid: true }) || [];
      for (const uid of uids) {
        if (Q.letto.get(uv, uid)) continue;
        let esito = 'errore';
        try {
          const m = await client.fetchOne(String(uid), { size: true, source: true }, { uid: true });
          if (!m || m.size > MAX_MESSAGGIO) esito = 'troppo-grande';
          else {
            const r = await elabora(await simpleParser(m.source));
            esito = r.esito;
            if (r.esito === 'ricevuto') { nuovi += r.salvati.length; avvisa(r); }
          }
        } catch (e) { console.error(`Posta: messaggio ${uid} non elaborato:`, e.message); }
        Q.segna.run(uv, uid, esito);
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
  Q.pulisci.run();
  return nuovi;
}

let errori = 0;
function avvia() {
  if (!attiva) return;
  const giro = async () => {
    try { await controlla(); errori = 0; } catch (e) {
      errori++;
      // Un solo messaggio nel registro finché il problema persiste
      if (errori === 1) console.error('Posta in arrivo non raggiungibile (riprovo ogni 5 minuti):', e.message);
    }
  };
  setTimeout(giro, 30 * 1000);
  setInterval(giro, 5 * 60 * 1000).unref();
}

module.exports = { attiva, elabora, controlla, avvia };
