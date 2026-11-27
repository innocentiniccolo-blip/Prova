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
  // Lavori del cliente: collegati a lui direttamente o alla sua azienda (agenzia, impresa)
  perCliente: db.prepare(`
    SELECT l.* FROM lavori l WHERE l.visibile = 1 AND (
      EXISTS (SELECT 1 FROM lavori_clienti lc WHERE lc.lavoro_id = l.id AND lc.utente_id = :u)
      OR EXISTS (SELECT 1 FROM lavori_aziende la JOIN utenti u ON u.azienda_id = la.azienda_id WHERE la.lavoro_id = l.id AND u.id = :u))
    ORDER BY l.aggiornato_il DESC`),
  delCliente: db.prepare(`
    SELECT l.* FROM lavori l WHERE l.id = :l AND l.visibile = 1 AND (
      EXISTS (SELECT 1 FROM lavori_clienti lc WHERE lc.lavoro_id = l.id AND lc.utente_id = :u)
      OR EXISTS (SELECT 1 FROM lavori_aziende la JOIN utenti u ON u.azienda_id = la.azienda_id WHERE la.lavoro_id = l.id AND u.id = :u))`),
  inserisci: db.prepare(`
    INSERT INTO lavori (codice, titolo, descrizione, indirizzo, stato, cartella, data_inizio, data_fine, visibile)
    VALUES (:codice, :titolo, :descrizione, :indirizzo, :stato, :cartella, :data_inizio, :data_fine, :visibile)`),
  aggiorna: db.prepare(`
    UPDATE lavori SET codice = :codice, titolo = :titolo, descrizione = :descrizione, indirizzo = :indirizzo,
      stato = :stato, cartella = :cartella, data_inizio = :data_inizio, data_fine = :data_fine,
      visibile = :visibile, aggiornato_il = datetime('now') WHERE id = :id`),
  tocca: db.prepare("UPDATE lavori SET aggiornato_il = datetime('now') WHERE id = ?"),
  elimina: db.prepare('DELETE FROM lavori WHERE id = ?'),
  clienti: db.prepare('SELECT u.id, u.nome, u.email, u.attivo, lc.ruolo, lc.consenso_il FROM utenti u JOIN lavori_clienti lc ON lc.utente_id = u.id WHERE lc.lavoro_id = ? ORDER BY u.nome'),
  ruoloCliente: db.prepare(`SELECT ruolo, consenso_il FROM lavori_clienti WHERE lavoro_id = :l AND utente_id = :u
    UNION ALL SELECT la.ruolo, la.consenso_il FROM lavori_aziende la JOIN utenti u ON u.azienda_id = la.azienda_id
    WHERE la.lavoro_id = :l AND u.id = :u LIMIT 1`),
  // Chi riceve gli avvisi: clienti diretti e persone delle aziende collegate, ciascuno con il suo ruolo
  destinatari: db.prepare(`SELECT u.id, u.nome, u.email, u.attivo, lc.ruolo FROM utenti u JOIN lavori_clienti lc ON lc.utente_id = u.id WHERE lc.lavoro_id = :l
    UNION SELECT u.id, u.nome, u.email, u.attivo, la.ruolo FROM utenti u JOIN lavori_aziende la ON la.azienda_id = u.azienda_id WHERE la.lavoro_id = :l
      AND u.id NOT IN (SELECT utente_id FROM lavori_clienti WHERE lavoro_id = :l)`),
  aziende: db.prepare(`SELECT a.*, la.ruolo, la.consenso_il FROM aziende a JOIN lavori_aziende la ON la.azienda_id = a.id WHERE la.lavoro_id = ? ORDER BY a.nome COLLATE NOCASE`),
  rimuoviAziende: db.prepare('DELETE FROM lavori_aziende WHERE lavoro_id = ?'),
  aggiungiAzienda: db.prepare('INSERT INTO lavori_aziende (lavoro_id, azienda_id, ruolo, consenso_il) VALUES (?, ?, ?, ?)'),
  impostaScheda: db.prepare("UPDATE lavori SET scheda = ?, aggiornato_il = datetime('now') WHERE id = ?"),
  aggiungiConRuolo: db.prepare(`INSERT INTO lavori_clienti (lavoro_id, utente_id, ruolo, consenso_il) VALUES (?, ?, ?, ?)
    ON CONFLICT (lavoro_id, utente_id) DO UPDATE SET ruolo = excluded.ruolo, consenso_il = excluded.consenso_il`),
  rimuoviClienti: db.prepare('DELETE FROM lavori_clienti WHERE lavoro_id = ?'),
  aggiungiCliente: db.prepare('INSERT OR IGNORE INTO lavori_clienti (lavoro_id, utente_id) VALUES (?, ?)'),
  prossimoCodice() {
    const anno = new Date().getFullYear();
    const r = db.prepare("SELECT codice FROM lavori WHERE codice LIKE ? ORDER BY codice DESC LIMIT 1").get(`${anno}-%`);
    const n = r ? Number(r.codice.split('-')[1]) + 1 || 1 : 1;
    return `${anno}-${String(n).padStart(3, '0')}`;
  },
};

const Aziende = {
  tutte: db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM utenti u WHERE u.azienda_id = a.id) AS n_persone,
    (SELECT COUNT(*) FROM lavori_aziende la WHERE la.azienda_id = a.id) AS n_lavori FROM aziende a ORDER BY a.nome COLLATE NOCASE`),
  perId: db.prepare('SELECT * FROM aziende WHERE id = ?'),
  inserisci: db.prepare('INSERT INTO aziende (nome, tipo, piva, email, telefono) VALUES (:nome, :tipo, :piva, :email, :telefono)'),
  aggiorna: db.prepare('UPDATE aziende SET nome = :nome, tipo = :tipo, piva = :piva, email = :email, telefono = :telefono WHERE id = :id'),
  elimina: db.prepare('DELETE FROM aziende WHERE id = ?'),
  persone: db.prepare("SELECT * FROM utenti WHERE azienda_id = ? AND ruolo = 'cliente' ORDER BY nome"),
  lavori: db.prepare('SELECT l.id, l.codice, l.titolo, l.stato, la.ruolo, la.consenso_il FROM lavori l JOIN lavori_aziende la ON la.lavoro_id = l.id WHERE la.azienda_id = ? ORDER BY l.codice DESC'),
};

const Utenti = {
  clienti: db.prepare(`
    SELECT u.*, COUNT(lc.lavoro_id) AS n_lavori, a.nome AS azienda FROM utenti u
    LEFT JOIN lavori_clienti lc ON lc.utente_id = u.id
    LEFT JOIN aziende a ON a.id = u.azienda_id
    WHERE u.ruolo = 'cliente' GROUP BY u.id ORDER BY u.nome`),
  impostaAzienda: db.prepare('UPDATE utenti SET azienda_id = ? WHERE id = ?'),
  perId: db.prepare('SELECT * FROM utenti WHERE id = ?'),
  perEmail: db.prepare('SELECT * FROM utenti WHERE email = ?'),
  contaAdmin: db.prepare("SELECT COUNT(*) AS n FROM utenti WHERE ruolo = 'admin'"),
  inserisci: db.prepare('INSERT INTO utenti (email, password_hash, nome, telefono, ruolo) VALUES (?, ?, ?, ?, ?)'),
  aggiorna: db.prepare('UPDATE utenti SET email = ?, nome = ?, telefono = ?, attivo = ? WHERE id = ?'),
  impostaPassword: db.prepare('UPDATE utenti SET password_hash = ? WHERE id = ?'),
  segnaInformativa: db.prepare("UPDATE utenti SET informativa_il = datetime('now') WHERE id = ? AND informativa_il IS NULL"),
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
  // Cartella scartata: sparisce dall'elenco delle pratiche e non è mai visibile a nessuno
  scarta: db.prepare('UPDATE pratiche SET scartata = ?, visibile = CASE WHEN ? THEN 0 ELSE visibile END, visibile_agenzia = CASE WHEN ? THEN 0 ELSE visibile_agenzia END, visibile_impresa = CASE WHEN ? THEN 0 ELSE visibile_impresa END WHERE id = ? AND lavoro_id = ?'),
  visibilitaRuoli: db.prepare('UPDATE pratiche SET visibile = ?, visibile_agenzia = ?, visibile_impresa = ? WHERE id = ? AND lavoro_id = ?'),
  // Tappe: integrazioni, inizio e fine lavori
  tappeLavoro: db.prepare("SELECT t.* FROM pratiche_tappe t JOIN pratiche p ON p.id = t.pratica_id WHERE p.lavoro_id = ? ORDER BY COALESCE(t.data, t.creato_il), t.id"),
  aggiungiTappa: db.prepare('INSERT INTO pratiche_tappe (pratica_id, fase, data, protocollo, file) VALUES (?, ?, ?, ?, ?)'),
  tappaUguale: db.prepare("SELECT id FROM pratiche_tappe WHERE pratica_id = ? AND fase = ? AND COALESCE(data, '') = COALESCE(?, '') AND COALESCE(protocollo, '') = COALESCE(?, '')"),
  eliminaTappa: db.prepare('DELETE FROM pratiche_tappe WHERE id = ? AND pratica_id IN (SELECT id FROM pratiche WHERE lavoro_id = ?)'),
};

const Aggiornamenti = {
  perLavoro: db.prepare('SELECT * FROM aggiornamenti WHERE lavoro_id = ? ORDER BY creato_il DESC, id DESC'),
  inserisci: db.prepare('INSERT INTO aggiornamenti (lavoro_id, testo) VALUES (?, ?)'),
  elimina: db.prepare('DELETE FROM aggiornamenti WHERE id = ? AND lavoro_id = ?'),
};

const Accessi = {
  perUtente: db.prepare('SELECT file AS documento, creato_il AS quando FROM accessi_file WHERE utente_id = ? ORDER BY id DESC'),
  registra: db.prepare('INSERT INTO accessi_file (lavoro_id, utente_id, file) VALUES (?, ?, ?)'),
  perLavoro: db.prepare(`
    SELECT a.*, u.nome FROM accessi_file a LEFT JOIN utenti u ON u.id = a.utente_id
    WHERE a.lavoro_id = ? AND (u.ruolo IS NULL OR u.ruolo = 'cliente')
    ORDER BY a.creato_il DESC LIMIT 50`),
};

module.exports = { Aziende, db, Lavori, Utenti, Pratiche, Aggiornamenti, Accessi };
