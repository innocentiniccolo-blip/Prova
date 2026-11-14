'use strict';
const db = require('./db');

const Lavori = {
  tutti: db.prepare(`
    SELECT l.*, GROUP_CONCAT(u.nome, ', ') AS clienti
    FROM lavori l
    LEFT JOIN lavori_clienti lc ON lc.lavoro_id = l.id
    LEFT JOIN utenti u ON u.id = lc.utente_id
    GROUP BY l.id ORDER BY l.aggiornato_il DESC`),
  perId: db.prepare('SELECT * FROM lavori WHERE id = ?'),
  perCliente: db.prepare(`
    SELECT l.* FROM lavori l JOIN lavori_clienti lc ON lc.lavoro_id = l.id
    WHERE lc.utente_id = ? AND l.visibile = 1 ORDER BY l.aggiornato_il DESC`),
  delCliente: db.prepare(`
    SELECT l.* FROM lavori l JOIN lavori_clienti lc ON lc.lavoro_id = l.id
    WHERE l.id = ? AND lc.utente_id = ? AND l.visibile = 1`),
  inserisci: db.prepare(`
    INSERT INTO lavori (codice, titolo, descrizione, indirizzo, stato, cartella, data_inizio, data_fine, visibile)
    VALUES (:codice, :titolo, :descrizione, :indirizzo, :stato, :cartella, :data_inizio, :data_fine, :visibile)`),
  aggiorna: db.prepare(`
    UPDATE lavori SET codice = :codice, titolo = :titolo, descrizione = :descrizione, indirizzo = :indirizzo,
      stato = :stato, cartella = :cartella, data_inizio = :data_inizio, data_fine = :data_fine,
      visibile = :visibile, aggiornato_il = datetime('now') WHERE id = :id`),
  tocca: db.prepare("UPDATE lavori SET aggiornato_il = datetime('now') WHERE id = ?"),
  elimina: db.prepare('DELETE FROM lavori WHERE id = ?'),
  clienti: db.prepare('SELECT u.id, u.nome, u.email, u.attivo FROM utenti u JOIN lavori_clienti lc ON lc.utente_id = u.id WHERE lc.lavoro_id = ? ORDER BY u.nome'),
  rimuoviClienti: db.prepare('DELETE FROM lavori_clienti WHERE lavoro_id = ?'),
  aggiungiCliente: db.prepare('INSERT OR IGNORE INTO lavori_clienti (lavoro_id, utente_id) VALUES (?, ?)'),
  prossimoCodice() {
    const anno = new Date().getFullYear();
    const r = db.prepare("SELECT codice FROM lavori WHERE codice LIKE ? ORDER BY codice DESC LIMIT 1").get(`${anno}-%`);
    const n = r ? Number(r.codice.split('-')[1]) + 1 || 1 : 1;
    return `${anno}-${String(n).padStart(3, '0')}`;
  },
};

const Utenti = {
  clienti: db.prepare(`
    SELECT u.*, COUNT(lc.lavoro_id) AS n_lavori FROM utenti u
    LEFT JOIN lavori_clienti lc ON lc.utente_id = u.id
    WHERE u.ruolo = 'cliente' GROUP BY u.id ORDER BY u.nome`),
  perId: db.prepare('SELECT * FROM utenti WHERE id = ?'),
  perEmail: db.prepare('SELECT * FROM utenti WHERE email = ?'),
  contaAdmin: db.prepare("SELECT COUNT(*) AS n FROM utenti WHERE ruolo = 'admin'"),
  inserisci: db.prepare('INSERT INTO utenti (email, password_hash, nome, telefono, ruolo) VALUES (?, ?, ?, ?, ?)'),
  aggiorna: db.prepare('UPDATE utenti SET email = ?, nome = ?, telefono = ?, attivo = ? WHERE id = ?'),
  impostaPassword: db.prepare('UPDATE utenti SET password_hash = ? WHERE id = ?'),
  segnaAccesso: db.prepare("UPDATE utenti SET ultimo_accesso = datetime('now') WHERE id = ?"),
  elimina: db.prepare("DELETE FROM utenti WHERE id = ? AND ruolo = 'cliente'"),
  lavori: db.prepare('SELECT l.id, l.codice, l.titolo, l.stato FROM lavori l JOIN lavori_clienti lc ON lc.lavoro_id = l.id WHERE lc.utente_id = ? ORDER BY l.codice DESC'),
  terminaSessioni: db.prepare("DELETE FROM sessioni WHERE json_extract(dati, '$.utenteId') = ?"),
  terminaAltreSessioni: db.prepare("DELETE FROM sessioni WHERE json_extract(dati, '$.utenteId') = ? AND sid != ?"),
};

const Pratiche = {
  perLavoro: db.prepare('SELECT * FROM pratiche WHERE lavoro_id = ?'),
  perId: db.prepare('SELECT * FROM pratiche WHERE id = ? AND lavoro_id = ?'),
  inserisci: db.prepare(`
    INSERT OR IGNORE INTO pratiche (lavoro_id, cartella, stato, visibile, ordine)
    VALUES (?, ?, ?, ?, ?)`),
  aggiorna: db.prepare(`
    UPDATE pratiche SET stato = :stato, data = :data, protocollo = :protocollo, nota = :nota,
      visibile = :visibile, aggiornato_il = datetime('now') WHERE id = :id AND lavoro_id = :lavoro_id`),
  elimina: db.prepare('DELETE FROM pratiche WHERE id = ? AND lavoro_id = ?'),
};

const Aggiornamenti = {
  perLavoro: db.prepare('SELECT * FROM aggiornamenti WHERE lavoro_id = ? ORDER BY creato_il DESC, id DESC'),
  inserisci: db.prepare('INSERT INTO aggiornamenti (lavoro_id, testo) VALUES (?, ?)'),
  elimina: db.prepare('DELETE FROM aggiornamenti WHERE id = ? AND lavoro_id = ?'),
};

const Accessi = {
  registra: db.prepare('INSERT INTO accessi_file (lavoro_id, utente_id, file) VALUES (?, ?, ?)'),
  perLavoro: db.prepare(`
    SELECT a.*, u.nome FROM accessi_file a LEFT JOIN utenti u ON u.id = a.utente_id
    WHERE a.lavoro_id = ? AND (u.ruolo IS NULL OR u.ruolo = 'cliente')
    ORDER BY a.creato_il DESC LIMIT 50`),
};

module.exports = { db, Lavori, Utenti, Pratiche, Aggiornamenti, Accessi };
