'use strict';
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

const qUtente = db.prepare('SELECT id, email, nome, ruolo, attivo FROM utenti WHERE id = ?');

/** Carica l'utente della sessione in req.utente / res.locals.utente. */
function caricaUtente(req, res, next) {
  const id = req.session?.utenteId;
  const u = id ? qUtente.get(id) : null;
  if (u && u.attivo) {
    req.utente = u;
  } else if (id) {
    delete req.session.utenteId; // utente disattivato o eliminato
  }
  res.locals.utente = req.utente || null;
  next();
}

function richiediLogin(req, res, next) {
  if (req.utente) return next();
  req.session.dopoLogin = req.originalUrl;
  res.redirect('/accedi');
}

function richiediAdmin(req, res, next) {
  if (!req.utente) return richiediLogin(req, res, next);
  if (req.utente.ruolo !== 'admin') return res.status(403).render('errore', { titolo: 'Accesso negato', messaggio: 'Questa sezione è riservata allo studio.' });
  next();
}

/** Protezione CSRF: token per sessione, richiesto su tutte le richieste che modificano dati. */
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  next();
}

function verificaCsrf(req, res, next) {
  const token = req.body?._csrf || req.get('x-csrf-token');
  const atteso = req.session.csrf;
  if (atteso && token && token.length === atteso.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(atteso))) {
    return next();
  }
  res.status(403).render('errore', { titolo: 'Sessione scaduta', messaggio: 'Ricarica la pagina e riprova.' });
}

// Limite ai tentativi di accesso: vedi tentativi.js (5 errori → blocco di 1 ora)
const tentativi = require('./tentativi');

const hashPassword = (pw) => bcrypt.hash(pw, 12);
const HASH_FINTO = bcrypt.hashSync('password-inesistente-' + crypto.randomBytes(8).toString('hex'), 12);
const verificaPassword = (pw, hash) => bcrypt.compare(pw, hash);

/** Password temporanea leggibile da comunicare al cliente (es. "tavolo-7342-Monte"). */
function passwordTemporanea() {
  const parole = ['Muro', 'Trave', 'Tetto', 'Scala', 'Porta', 'Pietra', 'Ponte', 'Torre', 'Monte', 'Fiume', 'Bosco', 'Prato', 'Sole', 'Vento', 'Luna', 'Mare'];
  const p = () => parole[crypto.randomInt(parole.length)];
  return `${p()}-${crypto.randomInt(1000, 10000)}-${p()}-${crypto.randomInt(10, 100)}`;
}

module.exports = {
  caricaUtente, richiediLogin, richiediAdmin, csrf, verificaCsrf,
  ...tentativi, HASH_FINTO,
  hashPassword, verificaPassword, passwordTemporanea,
};
