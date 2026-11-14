'use strict';
/**
 * Link monouso per impostare la password: usati da "Password dimenticata?" (validi 1 ora)
 * e dall'email di benvenuto ai nuovi clienti (validi 7 giorni).
 * Nel database si salva solo l'impronta SHA-256 del token, mai il token.
 */
const crypto = require('node:crypto');
const db = require('./db');
const config = require('./config');

const ORA = 60 * 60 * 1000;
const impronta = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

const q = {
  annullaPrecedenti: db.prepare('UPDATE link_password SET usato = 1 WHERE utente_id = ? AND usato = 0'),
  inserisci: db.prepare('INSERT INTO link_password (utente_id, impronta, scade) VALUES (?, ?, ?)'),
  valido: db.prepare(`
    SELECT lp.id, u.id AS utente_id, u.email, u.nome FROM link_password lp JOIN utenti u ON u.id = lp.utente_id
    WHERE lp.impronta = ? AND lp.usato = 0 AND lp.scade > ? AND u.attivo = 1`),
  usa: db.prepare('UPDATE link_password SET usato = 1 WHERE id = ? AND usato = 0'),
  pulisci: db.prepare('DELETE FROM link_password WHERE scade < ? OR usato = 1'),
};

/** Crea un nuovo link per l'utente (annulla quelli precedenti) e restituisce l'indirizzo completo. */
function crea(utenteId, ore, req) {
  q.pulisci.run(Date.now() - 24 * ORA);
  q.annullaPrecedenti.run(utenteId);
  const token = crypto.randomBytes(32).toString('base64url');
  q.inserisci.run(utenteId, impronta(token), Date.now() + ore * ORA);
  // In produzione si usa sempre URL_PUBBLICO: non ci si fida dell'host indicato dalla richiesta
  const base = config.urlPubblico || (config.produzione ? '' : `${req.protocol}://${req.get('host')}`);
  return `${base}/imposta-password/${token}`;
}

/** Restituisce { id, utente_id, email, nome } se il token è valido, altrimenti null. */
function verifica(token) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(String(token || ''))) return null;
  return q.valido.get(impronta(token), Date.now()) || null;
}

/** Segna il link come usato; false se nel frattempo era già stato usato. */
function consuma(id) {
  return q.usa.run(id).changes === 1;
}

module.exports = { crea, verifica, consuma };
