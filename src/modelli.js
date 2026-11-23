'use strict';
const db = require('./db');

const Lavori = {
  elenco: db.prepare('SELECT id, codice, titolo FROM lavori ORDER BY codice DESC'),
  tutti: db.prepare(`
    SELECT l.*, GROUP_CONCAT(u.nome, ', ') AS clienti,
      (SELECT COUNT(*) FROM pratiche p WHERE p.lavoro_id = l.id) AS n_pratiche
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
  clienti: db.prepare('SELECT u.id, u.nome, u.email, u.telefono FROM utenti u JOIN lavori_clienti lc ON lc.utente_id = u.id WHERE lc.lavoro_id = ? ORDER BY u.nome'),
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
  inserisci: db.prepare('INSERT INTO utenti (email, password_hash, nome, telefono, ruolo) VALUES (?, ?, ?, ?, ?)'),
  aggiorna: db.prepare('UPDATE utenti SET email = ?, nome = ?, telefono = ?, attivo = ? WHERE id = ?'),
  impostaPassword: db.prepare('UPDATE utenti SET password_hash = ? WHERE id = ?'),
  segnaAccesso: db.prepare("UPDATE utenti SET ultimo_accesso = datetime('now') WHERE id = ?"),
  elimina: db.prepare("DELETE FROM utenti WHERE id = ? AND ruolo = 'cliente'"),
  lavori: db.prepare('SELECT l.id, l.codice, l.titolo, l.stato FROM lavori l JOIN lavori_clienti lc ON lc.lavoro_id = l.id WHERE lc.utente_id = ? ORDER BY l.codice DESC'),
  terminaSessioni: db.prepare("DELETE FROM sessioni WHERE json_extract(dati, '$.utenteId') = ?"),
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

// ---------- Pratiche (uso interno dello studio) ----------
const SELECT_PRATICA = `
  SELECT p.*, l.codice AS lavoro_codice, l.titolo AS lavoro_titolo, l.indirizzo AS lavoro_indirizzo,
    (SELECT COALESCE(SUM(importo_cent), 0) FROM incassi i WHERE i.pratica_id = p.id) AS incassato_cent,
    (SELECT MIN(data) FROM scadenze s WHERE s.pratica_id = p.id AND s.fatta = 0) AS prossima_scadenza,
    (SELECT COUNT(*) FROM attivita a WHERE a.pratica_id = p.id AND a.fatta = 0) AS n_attivita,
    (SELECT GROUP_CONCAT(u.nome, ', ') FROM lavori_clienti lc JOIN utenti u ON u.id = lc.utente_id WHERE lc.lavoro_id = p.lavoro_id) AS clienti
  FROM pratiche p JOIN lavori l ON l.id = p.lavoro_id`;

const Pratiche = {
  tutte: db.prepare(`${SELECT_PRATICA} ORDER BY p.aggiornato_il DESC`),
  perId: db.prepare(`${SELECT_PRATICA} WHERE p.id = ?`),
  perLavoro: db.prepare(`${SELECT_PRATICA} WHERE p.lavoro_id = ? ORDER BY p.creato_il DESC`),
  inserisci: db.prepare(`
    INSERT INTO pratiche (lavoro_id, tipo, ente, oggetto, stato, protocollo, data_protocollo, numero_pratica, onorario_cent, note)
    VALUES (:lavoro_id, :tipo, :ente, :oggetto, :stato, :protocollo, :data_protocollo, :numero_pratica, :onorario_cent, :note)`),
  aggiorna: db.prepare(`
    UPDATE pratiche SET lavoro_id = :lavoro_id, tipo = :tipo, ente = :ente, oggetto = :oggetto, stato = :stato,
      protocollo = :protocollo, data_protocollo = :data_protocollo, numero_pratica = :numero_pratica,
      onorario_cent = :onorario_cent, note = :note, aggiornato_il = datetime('now') WHERE id = :id`),
  tocca: db.prepare("UPDATE pratiche SET aggiornato_il = datetime('now') WHERE id = ?"),
  elimina: db.prepare('DELETE FROM pratiche WHERE id = ?'),
};

const Scadenze = {
  perPratica: db.prepare('SELECT * FROM scadenze WHERE pratica_id = ? ORDER BY fatta, data, id'),
  aperteFinoA: db.prepare(`
    SELECT s.*, p.tipo, p.ente, p.lavoro_id, l.codice AS lavoro_codice, l.titolo AS lavoro_titolo
    FROM scadenze s JOIN pratiche p ON p.id = s.pratica_id JOIN lavori l ON l.id = p.lavoro_id
    WHERE s.fatta = 0 AND s.data <= ? ORDER BY s.data, s.id`),
  inserisci: db.prepare('INSERT INTO scadenze (pratica_id, descrizione, data) VALUES (?, ?, ?)'),
  segna: db.prepare("UPDATE scadenze SET fatta = :fatta, fatta_il = CASE WHEN :fatta = 1 THEN datetime('now') END WHERE id = :id AND pratica_id = :pratica_id"),
  elimina: db.prepare('DELETE FROM scadenze WHERE id = ? AND pratica_id = ?'),
};

const Attivita = {
  perPratica: db.prepare('SELECT * FROM attivita WHERE pratica_id = ? ORDER BY fatta, id'),
  aperte: db.prepare(`
    SELECT a.*, p.tipo, p.ente, l.codice AS lavoro_codice, l.titolo AS lavoro_titolo
    FROM attivita a JOIN pratiche p ON p.id = a.pratica_id JOIN lavori l ON l.id = p.lavoro_id
    WHERE a.fatta = 0 ORDER BY a.id`),
  inserisci: db.prepare('INSERT INTO attivita (pratica_id, testo) VALUES (?, ?)'),
  segna: db.prepare("UPDATE attivita SET fatta = :fatta, fatta_il = CASE WHEN :fatta = 1 THEN datetime('now') END WHERE id = :id AND pratica_id = :pratica_id"),
  elimina: db.prepare('DELETE FROM attivita WHERE id = ? AND pratica_id = ?'),
};

const Incassi = {
  perPratica: db.prepare('SELECT * FROM incassi WHERE pratica_id = ? ORDER BY data DESC, id DESC'),
  inserisci: db.prepare('INSERT INTO incassi (pratica_id, data, importo_cent, descrizione) VALUES (?, ?, ?, ?)'),
  elimina: db.prepare('DELETE FROM incassi WHERE id = ? AND pratica_id = ?'),
  totaleAnno: db.prepare("SELECT COALESCE(SUM(importo_cent), 0) AS tot FROM incassi WHERE substr(data, 1, 4) = ?"),
};

const Comunicazioni = {
  perPratica: db.prepare('SELECT * FROM comunicazioni WHERE pratica_id = ? ORDER BY creato_il DESC, id DESC LIMIT 100'),
  inserisci: db.prepare('INSERT INTO comunicazioni (pratica_id, canale, destinatario, oggetto, testo) VALUES (?, ?, ?, ?, ?)'),
  elimina: db.prepare('DELETE FROM comunicazioni WHERE id = ? AND pratica_id = ?'),
};

module.exports = { db, Lavori, Utenti, Aggiornamenti, Accessi, Pratiche, Scadenze, Attivita, Incassi, Comunicazioni };
