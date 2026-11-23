'use strict';
/**
 * Il cruscotto è pensato per il solo PC dell'ufficio:
 * - il server ascolta solo su 127.0.0.1 (vedi server.js), quindi dalla rete non si raggiunge;
 * - qui rifiutiamo anche le richieste che non arrivano dal PC stesso o che usano un nome diverso
 *   da "localhost" (protegge da siti web malevoli che provano a parlare con il cruscotto);
 * - ogni modulo ha un token anti-falsificazione (CSRF).
 */
const crypto = require('node:crypto');

const HOST_LOCALI = new Set(['localhost', '127.0.0.1', '[::1]']);
const IP_LOCALI = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function soloLocale(req, res, next) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (IP_LOCALI.has(req.socket.remoteAddress) && HOST_LOCALI.has(host)) return next();
  res.status(403).type('text').send('Il cruscotto si usa solo dal PC dello studio: apri http://localhost dal PC su cui è installato.');
}

function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  next();
}

function verificaCsrf(req, res, next) {
  const token = req.body?._csrf || req.get('x-csrf-token');
  const atteso = req.session.csrf;
  if (atteso && token && token.length === atteso.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(atteso))) return next();
  res.status(403).render('errore', { titolo: 'Pagina scaduta', messaggio: 'Ricarica la pagina e riprova.' });
}

module.exports = { soloLocale, csrf, verificaCsrf };
