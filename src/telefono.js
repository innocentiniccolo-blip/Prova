'use strict';
/** Numeri di telefono: link per chiamare e per aprire WhatsApp (il messaggio lo invia sempre la persona, a mano). */

/** Numero in formato internazionale senza "+" (es. 393398561221), o '' se non sembra un numero valido. */
function internazionale(numero) {
  let n = String(numero || '').replace(/[^\d+]/g, '');
  if (n.startsWith('+')) n = n.slice(1);
  else if (n.startsWith('00')) n = n.slice(2);
  else if (/^[03]\d{5,10}$/.test(n)) n = `39${n}`; // numero italiano scritto senza prefisso
  return /^\d{8,15}$/.test(n) ? n : '';
}

/** Link per chiamare (tel:), o '' */
const tel = (numero) => { const n = internazionale(numero); return n ? `tel:+${n}` : ''; };

/** Link WhatsApp con testo già scritto, o ''. Utile solo per i cellulari. */
const whatsapp = (numero, testo = '') => {
  const n = internazionale(numero);
  return n ? `https://wa.me/${n}${testo ? `?text=${encodeURIComponent(testo)}` : ''}` : '';
};

/** Probabile cellulare (italiano: inizia con 3 dopo il prefisso 39; esteri: si lascia provare) */
const cellulare = (numero) => { const n = internazionale(numero); return Boolean(n) && (!n.startsWith('39') || n.startsWith('393')); };

module.exports = { internazionale, tel, whatsapp, cellulare };
