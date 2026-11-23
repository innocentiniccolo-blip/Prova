'use strict';
/**
 * Lettura dei file creati da WhatsApp con "Esporta chat" (Android e iPhone, in italiano o inglese).
 *   Android: 23/11/26, 18:03 - Mario Rossi: testo
 *   iPhone:  [23/11/26, 18:03:12] Mario Rossi: testo
 * Le righe che non iniziano con data e ora continuano il messaggio precedente (messaggi su più righe).
 * Le righe di sistema (crittografia, "X ha creato il gruppo"...) vengono saltate.
 */

const INVISIBILI = /[‎‏‪-‮﻿]/g;
const DATA = String.raw`(\d{1,2})[/.](\d{1,2})[/.](\d{2,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?(?:\s*([AaPp]\.?\s?[Mm]\.?))?`;
const RIGA_ANDROID = new RegExp(`^${DATA}\\s+-\\s+(.*)$`);
const RIGA_IPHONE = new RegExp(`^\\[${DATA}\\]\\s+(.*)$`);

function componiData(g) {
  let [, gg, mm, aa, hh, mi, , ampm] = g;
  let anno = Number(aa);
  if (anno < 100) anno += 2000;
  let ore = Number(hh);
  if (ampm) {
    const pm = /p/i.test(ampm);
    if (pm && ore < 12) ore += 12;
    if (!pm && ore === 12) ore = 0;
  }
  const p2 = (n) => String(n).padStart(2, '0');
  return `${anno}-${p2(mm)}-${p2(gg)} ${p2(ore)}:${p2(mi)}`;
}

/** Divide "Autore: testo"; null se è una riga di sistema senza autore. */
function autoreETesto(resto) {
  const i = resto.indexOf(': ');
  if (i <= 0 || i > 80) return null;
  return { autore: resto.slice(0, i).trim(), testo: resto.slice(i + 2) };
}

/** @returns {{data: string, autore: string, testo: string}[]} */
function leggiChat(testoFile) {
  const messaggi = [];
  let corrente = null;
  for (const grezza of String(testoFile).replace(/\r\n?/g, '\n').split('\n')) {
    const riga = grezza.replace(INVISIBILI, '');
    const m = RIGA_IPHONE.exec(riga) || RIGA_ANDROID.exec(riga);
    if (m) {
      const at = autoreETesto(m[8]);
      if (!at) { corrente = null; continue; } // messaggio di sistema
      corrente = { data: componiData(m), autore: at.autore, testo: at.testo };
      messaggi.push(corrente);
    } else if (corrente) {
      corrente.testo += `\n${riga}`;
    }
  }
  for (const m of messaggi) m.testo = m.testo.trim();
  return messaggi.filter((m) => m.testo);
}

/** "Chat WhatsApp con Mario Rossi (1).zip" → "Mario Rossi". */
function nomeDaFile(nomeFile) {
  return String(nomeFile)
    .replace(/\.(txt|zip)$/i, '')
    .replace(/\s*\(\d+\)$/, '')
    .replace(/^(Chat WhatsApp con|Chat di WhatsApp con|WhatsApp Chat with|WhatsApp Chat -)\s*/i, '')
    .trim();
}

/** Se il nome della chat è un numero (contatto non salvato), ritorna solo le cifre. */
function telefonoDaNome(nome) {
  const s = String(nome).replace(INVISIBILI, '');
  return /^\+?[\d\s\-().]{8,}$/.test(s) ? s.replace(/\D/g, '') : null;
}

/** Nome confrontabile: minuscole, senza accenti né punteggiatura. */
function normalizzaNome(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

module.exports = { leggiChat, nomeDaFile, telefonoDaNome, normalizzaNome };
