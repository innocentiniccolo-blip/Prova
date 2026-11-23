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
  perEmail: db.prepare("SELECT * FROM clienti WHERE lower(email) = lower(?) AND email <> '' ORDER BY id LIMIT 1"),
  inserisci: db.prepare('INSERT INTO clienti (nome, telefono, email, note) VALUES (:nome, :telefono, :email, :note)'),
  aggiorna: db.prepare('UPDATE clienti SET nome = :nome, telefono = :telefono, email = :email, note = :note WHERE id = :id'),
  elimina: db.prepare('DELETE FROM clienti WHERE id = ?'),
};

const Pratiche = {
  tutte: db.prepare(`${SELECT_PRATICA} ORDER BY p.aggiornato_il DESC`),
  perId: db.prepare(`${SELECT_PRATICA} WHERE p.id = ?`),
  perCliente: db.prepare(`${SELECT_PRATICA} WHERE p.cliente_id = ? ORDER BY p.creato_il DESC`),
  inserisci: db.prepare(`
    INSERT INTO pratiche (cliente_id, commessa, indirizzo, cartella, tipo, ente, oggetto, stato, protocollo, data_protocollo, numero_pratica, onorario_cent, note)
    VALUES (:cliente_id, :commessa, :indirizzo, :cartella, :tipo, :ente, :oggetto, :stato, :protocollo, :data_protocollo, :numero_pratica, :onorario_cent, :note)`),
  aggiorna: db.prepare(`
    UPDATE pratiche SET cliente_id = :cliente_id, commessa = :commessa, indirizzo = :indirizzo, cartella = :cartella, tipo = :tipo, ente = :ente,
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

const SELECT_EMAIL = `
  SELECT e.*, c.nome AS cliente_nome, p.tipo AS pratica_tipo, p.ente AS pratica_ente, p.commessa AS pratica_commessa
  FROM email_ricevute e LEFT JOIN clienti c ON c.id = e.cliente_id LEFT JOIN pratiche p ON p.id = e.pratica_id`;

const Email = {
  esiste: db.prepare('SELECT id FROM email_ricevute WHERE uidvalidity = ? AND uid = ?'),
  inserisci: db.prepare(`
    INSERT OR IGNORE INTO email_ricevute (uidvalidity, uid, message_id, riferimenti, mittente_nome, mittente_email, rispondi_a, oggetto, data, testo, cliente_id, pratica_id)
    VALUES (:uidvalidity, :uid, :message_id, :riferimenti, :mittente_nome, :mittente_email, :rispondi_a, :oggetto, :data, :testo, :cliente_id, :pratica_id)`),
  perId: db.prepare(`${SELECT_EMAIL} WHERE e.id = ?`),
  daRispondere: db.prepare(`${SELECT_EMAIL} WHERE e.stato IN ('nuova','bozza') ORDER BY e.data DESC`),
  perStato: db.prepare(`${SELECT_EMAIL} WHERE e.stato = ? ORDER BY e.data DESC LIMIT 300`),
  tutte: db.prepare(`${SELECT_EMAIL} ORDER BY e.data DESC LIMIT 300`),
  perPratica: db.prepare(`${SELECT_EMAIL} WHERE e.pratica_id = ? ORDER BY e.data DESC LIMIT 50`),
  contaDaRispondere: db.prepare("SELECT COUNT(*) AS n FROM email_ricevute WHERE stato IN ('nuova','bozza')"),
  senzaBozza: db.prepare("SELECT id FROM email_ricevute WHERE stato = 'nuova' AND bozza_testo IS NULL AND errore_ai IS NULL ORDER BY data DESC LIMIT ?"),
  salvaBozza: db.prepare(`UPDATE email_ricevute SET bozza_oggetto = :bozza_oggetto, bozza_testo = :bozza_testo, riassunto = :riassunto,
    serve_risposta = :serve_risposta, errore_ai = NULL, stato = CASE WHEN stato = 'nuova' THEN 'bozza' ELSE stato END WHERE id = :id`),
  modificaBozza: db.prepare("UPDATE email_ricevute SET bozza_oggetto = ?, bozza_testo = ?, stato = CASE WHEN stato = 'nuova' THEN 'bozza' ELSE stato END WHERE id = ?"),
  erroreAi: db.prepare('UPDATE email_ricevute SET errore_ai = ? WHERE id = ?'),
  abbina: db.prepare('UPDATE email_ricevute SET pratica_id = ? WHERE id = ?'),
  cambiaStato: db.prepare("UPDATE email_ricevute SET stato = ?, risposta_il = CASE WHEN ? = 'inviata' THEN datetime('now') ELSE risposta_il END WHERE id = ?"),
  ultimoUid: db.prepare('SELECT MAX(uid) AS uid FROM email_ricevute WHERE uidvalidity = ?'),
};

const Impostazioni = {
  leggi: (chiave) => db.prepare('SELECT valore FROM impostazioni WHERE chiave = ?').get(chiave)?.valore ?? null,
  scrivi: (chiave, valore) => db.prepare('INSERT INTO impostazioni (chiave, valore) VALUES (?, ?) ON CONFLICT(chiave) DO UPDATE SET valore = excluded.valore').run(chiave, valore == null ? null : String(valore)),
};

const SELECT_CHAT = `
  SELECT w.*, c.nome AS cliente_nome, c.telefono AS cliente_telefono,
    (SELECT COUNT(*) FROM whatsapp_messaggi m WHERE m.chat_id = w.id) AS n_messaggi,
    (SELECT testo FROM whatsapp_messaggi m WHERE m.chat_id = w.id ORDER BY data DESC, id DESC LIMIT 1) AS ultimo_testo
  FROM whatsapp_chat w LEFT JOIN clienti c ON c.id = w.cliente_id`;

const Whatsapp = {
  perNome: db.prepare('SELECT * FROM whatsapp_chat WHERE nome = ?'),
  perId: db.prepare(`${SELECT_CHAT} WHERE w.id = ?`),
  tutte: db.prepare(`${SELECT_CHAT} ORDER BY CASE w.stato WHEN 'gestita' THEN 1 ELSE 0 END, w.ultimo_msg_il DESC`),
  daRispondere: db.prepare(`${SELECT_CHAT} WHERE w.stato IN ('da_rispondere','bozza') ORDER BY w.ultimo_msg_il DESC`),
  perCliente: db.prepare(`${SELECT_CHAT} WHERE w.cliente_id = ? ORDER BY w.ultimo_msg_il DESC`),
  contaDaRispondere: db.prepare("SELECT COUNT(*) AS n FROM whatsapp_chat WHERE stato IN ('da_rispondere','bozza')"),
  inserisci: db.prepare('INSERT INTO whatsapp_chat (nome, telefono, cliente_id) VALUES (?, ?, ?)'),
  collega: db.prepare('UPDATE whatsapp_chat SET cliente_id = ? WHERE id = ?'),
  dopoImport: db.prepare("UPDATE whatsapp_chat SET ultimo_msg_il = :ultimo, importata_il = datetime('now'), stato = :stato, errore_ai = CASE WHEN :stato = 'da_rispondere' THEN NULL ELSE errore_ai END WHERE id = :id"),
  salvaBozza: db.prepare("UPDATE whatsapp_chat SET riassunto = :riassunto, bozza_testo = :bozza_testo, errore_ai = NULL, stato = CASE WHEN :serve = 1 THEN 'bozza' ELSE stato END WHERE id = :id"),
  modificaBozza: db.prepare('UPDATE whatsapp_chat SET bozza_testo = ? WHERE id = ?'),
  erroreAi: db.prepare('UPDATE whatsapp_chat SET errore_ai = ? WHERE id = ?'),
  cambiaStato: db.prepare('UPDATE whatsapp_chat SET stato = ? WHERE id = ?'),
  messaggi: db.prepare('SELECT * FROM (SELECT * FROM whatsapp_messaggi WHERE chat_id = ? ORDER BY data DESC, id DESC LIMIT ?) ORDER BY data, id'),
  inserisciMsg: db.prepare('INSERT OR IGNORE INTO whatsapp_messaggi (chat_id, data, autore, mio, testo, impronta) VALUES (?, ?, ?, ?, ?, ?)'),
  ricalcolaMio: db.prepare('UPDATE whatsapp_messaggi SET mio = ? WHERE chat_id = ? AND autore = ?'),
  ultimoMsg: db.prepare('SELECT * FROM whatsapp_messaggi WHERE chat_id = ? ORDER BY data DESC, id DESC LIMIT 1'),
};

module.exports = { db, Clienti, Pratiche, Scadenze, Attivita, Incassi, Comunicazioni, Email, Impostazioni, Whatsapp };
