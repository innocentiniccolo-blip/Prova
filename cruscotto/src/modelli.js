'use strict';
const db = require('./db');

const SELECT_PRATICA = `
  SELECT p.*, c.nome AS cliente_nome, c.telefono AS cliente_telefono, c.email AS cliente_email,
    (SELECT COALESCE(SUM(importo_cent), 0) FROM incassi i WHERE i.pratica_id = p.id) AS incassato_cent,
    (SELECT MIN(data) FROM scadenze s WHERE s.pratica_id = p.id AND s.fatta = 0) AS prossima_scadenza,
    (SELECT COUNT(*) FROM attivita a WHERE a.pratica_id = p.id AND a.fatta = 0) AS n_attivita
  FROM pratiche p LEFT JOIN clienti c ON c.id = p.cliente_id`;

const Clienti = {
  tutti: db.prepare(`
    SELECT c.*, COUNT(p.id) AS n_pratiche FROM clienti c LEFT JOIN pratiche p ON p.cliente_id = c.id
    GROUP BY c.id ORDER BY c.nome COLLATE NOCASE`),
  perId: db.prepare('SELECT * FROM clienti WHERE id = ?'),
  inserisci: db.prepare('INSERT INTO clienti (nome, telefono, email, note) VALUES (:nome, :telefono, :email, :note)'),
  aggiorna: db.prepare('UPDATE clienti SET nome = :nome, telefono = :telefono, email = :email, note = :note WHERE id = :id'),
  elimina: db.prepare('DELETE FROM clienti WHERE id = ?'),
};

const Pratiche = {
  tutte: db.prepare(`${SELECT_PRATICA} ORDER BY p.aggiornato_il DESC`),
  perId: db.prepare(`${SELECT_PRATICA} WHERE p.id = ?`),
  perCliente: db.prepare(`${SELECT_PRATICA} WHERE p.cliente_id = ? ORDER BY p.creato_il DESC`),
  inserisci: db.prepare(`
    INSERT INTO pratiche (cliente_id, commessa, indirizzo, tipo, ente, oggetto, stato, protocollo, data_protocollo, numero_pratica, onorario_cent, note)
    VALUES (:cliente_id, :commessa, :indirizzo, :tipo, :ente, :oggetto, :stato, :protocollo, :data_protocollo, :numero_pratica, :onorario_cent, :note)`),
  aggiorna: db.prepare(`
    UPDATE pratiche SET cliente_id = :cliente_id, commessa = :commessa, indirizzo = :indirizzo, tipo = :tipo, ente = :ente,
      oggetto = :oggetto, stato = :stato, protocollo = :protocollo, data_protocollo = :data_protocollo,
      numero_pratica = :numero_pratica, onorario_cent = :onorario_cent, note = :note, aggiornato_il = datetime('now') WHERE id = :id`),
  cambiaStato: db.prepare("UPDATE pratiche SET stato = ?, aggiornato_il = datetime('now') WHERE id = ?"),
  tocca: db.prepare("UPDATE pratiche SET aggiornato_il = datetime('now') WHERE id = ?"),
  elimina: db.prepare('DELETE FROM pratiche WHERE id = ?'),
};

const RIF_PRATICA = `p.tipo, p.ente, p.commessa, c.nome AS cliente_nome
    FROM pratiche p LEFT JOIN clienti c ON c.id = p.cliente_id`;

const Scadenze = {
  perPratica: db.prepare('SELECT * FROM scadenze WHERE pratica_id = ? ORDER BY fatta, data, id'),
  aperteFinoA: db.prepare(`SELECT s.*, ${RIF_PRATICA} JOIN scadenze s ON s.pratica_id = p.id WHERE s.fatta = 0 AND s.data <= ? ORDER BY s.data, s.id`),
  inserisci: db.prepare('INSERT INTO scadenze (pratica_id, descrizione, data) VALUES (?, ?, ?)'),
  segna: db.prepare("UPDATE scadenze SET fatta = :fatta, fatta_il = CASE WHEN :fatta = 1 THEN datetime('now') END WHERE id = :id AND pratica_id = :pratica_id"),
  elimina: db.prepare('DELETE FROM scadenze WHERE id = ? AND pratica_id = ?'),
};

const Attivita = {
  perPratica: db.prepare('SELECT * FROM attivita WHERE pratica_id = ? ORDER BY fatta, id'),
  aperte: db.prepare(`SELECT a.*, ${RIF_PRATICA} JOIN attivita a ON a.pratica_id = p.id WHERE a.fatta = 0 ORDER BY a.id`),
  inserisci: db.prepare('INSERT INTO attivita (pratica_id, testo) VALUES (?, ?)'),
  segna: db.prepare("UPDATE attivita SET fatta = :fatta, fatta_il = CASE WHEN :fatta = 1 THEN datetime('now') END WHERE id = :id AND pratica_id = :pratica_id"),
  elimina: db.prepare('DELETE FROM attivita WHERE id = ? AND pratica_id = ?'),
};

const Incassi = {
  perPratica: db.prepare('SELECT * FROM incassi WHERE pratica_id = ? ORDER BY data DESC, id DESC'),
  inserisci: db.prepare('INSERT INTO incassi (pratica_id, data, importo_cent, descrizione) VALUES (?, ?, ?, ?)'),
  elimina: db.prepare('DELETE FROM incassi WHERE id = ? AND pratica_id = ?'),
  totaleAnno: db.prepare('SELECT COALESCE(SUM(importo_cent), 0) AS tot FROM incassi WHERE substr(data, 1, 4) = ?'),
};

const Comunicazioni = {
  perPratica: db.prepare('SELECT * FROM comunicazioni WHERE pratica_id = ? ORDER BY creato_il DESC, id DESC LIMIT 100'),
  inserisci: db.prepare('INSERT INTO comunicazioni (pratica_id, canale, destinatario, oggetto, testo) VALUES (?, ?, ?, ?, ?)'),
  elimina: db.prepare('DELETE FROM comunicazioni WHERE id = ? AND pratica_id = ?'),
};

module.exports = { db, Clienti, Pratiche, Scadenze, Attivita, Incassi, Comunicazioni };
