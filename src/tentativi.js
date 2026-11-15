'use strict';
/**
 * Limite ai tentativi di accesso falliti.
 *  - 5 errori entro un'ora sulla stessa email dallo stesso indirizzo IP → blocco di 1 ora
 *  - 20 errori entro un'ora dallo stesso IP (chi prova molte email diverse) → blocco di 1 ora
 * I contatori stanno nel database: un riavvio del servizio non azzera i blocchi.
 */
const db = require('./db');

const ORA = 60 * 60 * 1000;
const MAX_ERRORI = 5;
const MAX_ERRORI_IP = 20;
const DURATA_BLOCCO = ORA;

db.exec(`CREATE TABLE IF NOT EXISTS tentativi_accesso (
  chiave       TEXT PRIMARY KEY,
  n            INTEGER NOT NULL,
  inizio       INTEGER NOT NULL,
  bloccato_dal INTEGER,
  ip           TEXT,
  email        TEXT
)`);

const q = {
  get: db.prepare('SELECT * FROM tentativi_accesso WHERE chiave = ?'),
  metti: db.prepare(`INSERT INTO tentativi_accesso (chiave, n, inizio, bloccato_dal, ip, email) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (chiave) DO UPDATE SET n = excluded.n, inizio = excluded.inizio, bloccato_dal = excluded.bloccato_dal`),
  togli: db.prepare('DELETE FROM tentativi_accesso WHERE chiave = ?'),
  togliEmail: db.prepare('DELETE FROM tentativi_accesso WHERE email = ?'),
  pulisci: db.prepare('DELETE FROM tentativi_accesso WHERE (bloccato_dal IS NULL AND inizio < ?) OR (bloccato_dal IS NOT NULL AND bloccato_dal < ?)'),
  bloccati: db.prepare('SELECT * FROM tentativi_accesso WHERE bloccato_dal IS NOT NULL AND bloccato_dal > ? ORDER BY bloccato_dal DESC'),
};

const norm = (s) => String(s || '').trim().toLowerCase().slice(0, 200);
const chiave = (ip, email) => `${ip}|${norm(email)}`;
const chiaveIp = (ip) => `ip|${ip}`;

function bloccata(k) {
  const t = q.get.get(k);
  return Boolean(t && t.bloccato_dal && Date.now() - t.bloccato_dal < DURATA_BLOCCO);
}

/** Registra un errore. Restituisce true se proprio questo errore ha fatto scattare il blocco. */
function errore(k, max, ip, email) {
  const ora = Date.now();
  const t = q.get.get(k);
  if (t && t.bloccato_dal && ora - t.bloccato_dal < DURATA_BLOCCO) return false; // già bloccata
  const nuova = !t || t.bloccato_dal || ora - t.inizio > ORA;
  const n = nuova ? 1 : t.n + 1;
  const scatta = n >= max;
  q.metti.run(k, n, nuova ? ora : t.inizio, scatta ? ora : null, ip || null, email || null);
  return scatta;
}

const loginBloccato = (req, email) => bloccata(chiave(req.ip, email));
const registraErrore = (req, email) => errore(chiave(req.ip, email), MAX_ERRORI, req.ip, norm(email));
const azzeraTentativi = (req, email) => { q.togli.run(chiave(req.ip, email)); };
/** Dopo un cambio password riuscito: toglie i blocchi su quell'email da qualsiasi indirizzo. */
const azzeraEmail = (email) => { q.togliEmail.run(norm(email)); };
const ipBloccato = (req) => bloccata(chiaveIp(req.ip));
const registraErroreIp = (req) => errore(chiaveIp(req.ip), MAX_ERRORI_IP, req.ip, null);

/** Blocchi in corso, per il pannello dello studio. */
function blocchiAttivi() {
  return q.bloccati.all(Date.now() - DURATA_BLOCCO).map((t) => ({ ...t, fino: t.bloccato_dal + DURATA_BLOCCO }));
}
function sblocca(k) { return q.togli.run(String(k)).changes === 1; }

setInterval(() => { try { q.pulisci.run(Date.now() - ORA, Date.now() - DURATA_BLOCCO); } catch (e) { console.error(e); } }, 10 * 60 * 1000).unref();

module.exports = {
  MAX_ERRORI, MAX_ERRORI_IP, DURATA_BLOCCO,
  loginBloccato, registraErrore, azzeraTentativi, azzeraEmail, ipBloccato, registraErroreIp, blocchiAttivi, sblocca,
};
