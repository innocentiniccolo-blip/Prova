'use strict';
/** Funzioni di supporto senza dipendenze: importi, date, telefoni e link di invio. */

const fmtEuro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', useGrouping: 'always' });

/** "1.234,56" / "1234,5" / "1234.50" / "€ 800" → centesimi (intero). Null se non valido. */
function euroInCentesimi(v) {
  let s = String(v ?? '').replace(/[€\s]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (!/^\d+\.\d{1,2}$/.test(s)) s = s.replace(/\./g, ''); // "1.200" = milleduecento
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

const euro = (cent) => fmtEuro.format((Number(cent) || 0) / 100);

/** Importo in centesimi → testo per un campo modulo ("1234,50"). */
const centesimiInTesto = (cent) => (cent ? (cent / 100).toFixed(2).replace('.', ',') : '');

/** Data odierna (YYYY-MM-DD) nel fuso dello studio. */
function oggi(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ || 'Europe/Rome' }).format(d);
}

/** Aggiunge giorni a una data YYYY-MM-DD. */
function piuGiorni(data, n) {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Giorni tra oggi e la data (negativo = scaduta). */
function giorniMancanti(data, rif = oggi()) {
  return Math.round((new Date(`${data}T12:00:00Z`) - new Date(`${rif}T12:00:00Z`)) / 86400000);
}

/** Classe e testo per evidenziare una scadenza. */
function urgenza(data, rif = oggi()) {
  const g = giorniMancanti(data, rif);
  if (g < 0) return { classe: 'scaduta', testo: g === -1 ? 'scaduta ieri' : `scaduta da ${-g} gg` };
  if (g === 0) return { classe: 'urgente', testo: 'oggi' };
  if (g === 1) return { classe: 'urgente', testo: 'domani' };
  if (g <= 7) return { classe: 'urgente', testo: `tra ${g} gg` };
  if (g <= 30) return { classe: 'vicina', testo: `tra ${g} gg` };
  return { classe: '', testo: `tra ${g} gg` };
}

/** Numero di telefono → formato internazionale solo cifre per wa.me (Italia di default). */
function telefonoWhatsapp(tel) {
  let t = String(tel ?? '').trim();
  if (!t) return null;
  const internazionale = t.startsWith('+') || t.startsWith('00');
  t = t.replace(/\D/g, '');
  if (t.startsWith('00')) t = t.slice(2);
  // Numeri italiani senza prefisso (cellulari 3xx…, fissi 0xx…) hanno al massimo 10-11 cifre
  if (!internazionale && (t.length <= 10 || (t.length === 11 && t.startsWith('0')))) t = `39${t}`;
  return t.length >= 10 && t.length <= 15 ? t : null;
}

function linkWhatsapp(tel, testo) {
  const n = telefonoWhatsapp(tel);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(testo)}` : null;
}

const emailValida = (e) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(String(e));

function linkEmail(email, oggetto, testo) {
  if (!emailValida(email)) return null;
  const q = [];
  if (oggetto) q.push(`subject=${encodeURIComponent(oggetto)}`);
  if (testo) q.push(`body=${encodeURIComponent(testo.replace(/\r?\n/g, '\r\n'))}`);
  return `mailto:${encodeURIComponent(email).replace('%40', '@')}${q.length ? '?' + q.join('&') : ''}`;
}

module.exports = {
  euroInCentesimi, euro, centesimiInTesto, oggi, piuGiorni, giorniMancanti, urgenza,
  telefonoWhatsapp, linkWhatsapp, emailValida, linkEmail,
};
