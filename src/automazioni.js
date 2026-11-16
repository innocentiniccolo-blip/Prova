'use strict';
/**
 * Automazioni:
 * 1. Nuovi lavori dal NAS: una cartella del lavoro con dentro il file "_cliente.txt"
 *    (riga 1: nome e cognome, riga 2: email, riga 3 facoltativa: telefono) diventa una
 *    proposta "Nuovo lavoro trovato". Confermandola si creano lavoro e cliente e parte
 *    l'email di benvenuto. Con AUTO_CONFERMA=true la conferma è automatica.
 * 2. Ricevute: i PDF nuovi nelle pratiche vengono letti; se sono ricevute riconosciute
 *    (protocollo comunale, DOCFA, APE, ENEA…) nasce una proposta di aggiornamento di
 *    stato con data e protocollo, da confermare con un clic (o automatica, vedi sopra).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');
const db = require('./db');
const archivio = require('./archivio');
const pratiche = require('./pratiche');
const ricevute = require('./ricevute');
const auth = require('./auth');
const notifiche = require('./notifiche');
const { Lavori, Utenti, Pratiche, Aggiornamenti } = require('./modelli');

const AUTO = process.env.AUTO_CONFERMA === 'true';

const q = {
  lavoroPerCartella: db.prepare('SELECT id FROM lavori WHERE cartella = ?'),
  propostaPerCartella: db.prepare('SELECT id FROM proposte_lavori WHERE cartella = ?'),
  inserisciProposta: db.prepare('INSERT INTO proposte_lavori (cartella, nome, email, telefono) VALUES (?, ?, ?, ?)'),
  proposteNuove: db.prepare("SELECT * FROM proposte_lavori WHERE stato = 'nuova' ORDER BY creato_il"),
  proposta: db.prepare('SELECT * FROM proposte_lavori WHERE id = ?'),
  statoProposta: db.prepare('UPDATE proposte_lavori SET stato = ? WHERE id = ?'),
  fileLetto: db.prepare('SELECT modificato FROM file_letti WHERE pratica_id = ? AND percorso = ?'),
  segnaLetto: db.prepare('INSERT OR REPLACE INTO file_letti (pratica_id, percorso, modificato) VALUES (?, ?, ?)'),
  inserisciPropStato: db.prepare('INSERT INTO proposte_stato (pratica_id, file, tipo, stato, data, protocollo) VALUES (?, ?, ?, ?, ?, ?)'),
  propStatoNuove: db.prepare(`
    SELECT ps.*, p.cartella, p.lavoro_id, l.codice, l.titolo FROM proposte_stato ps
    JOIN pratiche p ON p.id = ps.pratica_id JOIN lavori l ON l.id = p.lavoro_id
    WHERE ps.stato_proposta = 'nuova' ORDER BY ps.creato_il`),
  propStatoPerLavoro: db.prepare(`
    SELECT ps.*, p.cartella FROM proposte_stato ps JOIN pratiche p ON p.id = ps.pratica_id
    WHERE ps.stato_proposta = 'nuova' AND p.lavoro_id = ? ORDER BY ps.creato_il`),
  propStato: db.prepare('SELECT * FROM proposte_stato WHERE id = ?'),
  esitoPropStato: db.prepare('UPDATE proposte_stato SET stato_proposta = ? WHERE id = ?'),
  scartaAltre: db.prepare(`UPDATE proposte_stato SET stato_proposta = 'scartata' WHERE pratica_id = ? AND stato_proposta = 'nuova' AND id <> ? AND stato NOT IN (${Object.keys(require('./tappe').STATI).map((x) => `'${x}'`).join(', ')})`),
};

const emailRe = /[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}/i;

/** Legge _cliente.txt: nome, email, telefono. Restituisce null se manca l'email. */
function leggiSchedaCliente(testo) {
  const righe = String(testo).replace(/^﻿/, '').split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  const email = (righe.join(' ').match(emailRe) || [])[0];
  if (!email) return null;
  const altre = righe.filter((r) => !emailRe.test(r)).map((r) => r.replace(/^(nome|cliente|email|telefono|tel\.?)\s*[:=]\s*/i, ''));
  const telefono = altre.find((r) => /^\+?[\d\s/.-]{6,}$/.test(r)) || null;
  const nome = altre.find((r) => r !== telefono) || email.split('@')[0];
  return { nome: nome.slice(0, 200), email: email.toLowerCase(), telefono: telefono && telefono.slice(0, 50) };
}

/** Codice e titolo dal nome della cartella: "026-2026-Bagiardi Andrea - Matassino". */
function codiceETitolo(cartella) {
  const base = cartella.split('/').pop();
  const m = base.match(/^(\d{1,4}[-_]\d{4})[\s_-]*(.*)$/);
  if (m) return { codice: m[1].replace('_', '-'), titolo: m[2].trim() || base };
  return { codice: null, titolo: base };
}

/** Cerca nuove cartelle di lavoro con _cliente.txt (primo e secondo livello dell'archivio). */
async function scansionaNuoviLavori() {
  const trovate = [];
  async function esplora(rel, livello) {
    const abs = archivio.risolviDentro(config.archivioDir, rel || '.');
    if (!abs) return;
    let voci;
    try { voci = await fsp.readdir(abs, { withFileTypes: true }); } catch { return; }
    const scheda = voci.find((v) => v.isFile() && v.name.toLowerCase() === '_cliente.txt');
    if (scheda && rel) {
      if (!q.lavoroPerCartella.get(rel) && !q.propostaPerCartella.get(rel)) {
        const dati = leggiSchedaCliente(await fsp.readFile(path.join(abs, scheda.name), 'utf8'));
        if (dati) {
          const { lastInsertRowid } = q.inserisciProposta.run(rel, dati.nome, dati.email, dati.telefono);
          trovate.push(Number(lastInsertRowid));
        }
      }
      return; // una cartella di lavoro non contiene altri lavori
    }
    // Con Google Drive ogni cartella condivisa è un lavoro: si propone anche senza _cliente.txt
    if (config.archivioSolaLettura && livello === 1 && rel) {
      if (!q.lavoroPerCartella.get(rel) && !q.propostaPerCartella.get(rel)) {
        const { lastInsertRowid } = q.inserisciProposta.run(rel, codiceETitolo(rel).titolo, '', null);
        trovate.push(Number(lastInsertRowid));
      }
      return;
    }
    if (livello >= 2) return;
    for (const v of voci) {
      if (v.isDirectory() && !v.name.startsWith('.') && !v.name.startsWith('_') && !v.name.startsWith('@') && v.name !== '#recycle') {
        await esplora(rel ? `${rel}/${v.name}` : v.name, livello + 1);
      }
    }
  }
  await esplora('', 0);
  if (AUTO) for (const id of trovate) if (q.proposta.get(id)?.email) await confermaLavoro(id, null).catch((e) => console.error(e));
  return trovate.length;
}

/** Crea lavoro e cliente da una proposta. Restituisce { lavoroId, clienteNuovo, emailInviata }. */
async function confermaLavoro(id, req, extra = {}) {
  const p = { ...q.proposta.get(id) };
  if (!p.id || p.stato !== 'nuova') throw new Error('Proposta non trovata o già gestita');
  // Email e nome del cliente indicati al momento della conferma (cartelle senza _cliente.txt)
  const email = String(extra.email || '').trim().toLowerCase();
  if (email) {
    if (!/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i.test(email)) throw new Error('Email del cliente non valida');
    p.email = email;
    p.nome = String(extra.nome || '').trim().slice(0, 200) || p.nome;
  }
  const { codice, titolo } = codiceETitolo(p.cartella);
  let cliente = p.email ? Utenti.perEmail.get(p.email) : null;
  let clienteNuovo = false;
  db.exec('BEGIN');
  let lavoroId;
  try {
    if (!cliente && p.email) {
      const pw = auth.passwordTemporanea();
      const { lastInsertRowid } = Utenti.inserisci.run(p.email, await auth.hashPassword(pw), p.nome, p.telefono, 'cliente');
      cliente = Utenti.perId.get(Number(lastInsertRowid));
      clienteNuovo = true;
    }
    let cod = codice || Lavori.prossimoCodice();
    if (db.prepare('SELECT 1 FROM lavori WHERE codice = ?').get(cod)) cod = `${cod}-${p.id}`;
    const r = Lavori.inserisci.run({
      codice: cod, titolo, descrizione: null, indirizzo: null, stato: config.studio.stati[1] || config.studio.stati[0],
      cartella: p.cartella, data_inizio: null, data_fine: null, visibile: 1,
    });
    lavoroId = Number(r.lastInsertRowid);
    if (cliente) Lavori.aggiungiCliente.run(lavoroId, cliente.id);
    q.statoProposta.run('confermata', id);
    db.exec('COMMIT');
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
  let emailInviata = false;
  if (clienteNuovo && cliente && cliente.ruolo === 'cliente') {
    try { emailInviata = await notifiche.inviaBenvenuto(req, cliente); } catch (e) { console.error(e); }
  }
  // Prime proposte di stato dalle ricevute già presenti
  await scansionaRicevute(Lavori.perId.get(lavoroId)).catch((e) => console.error(e));
  await require('./sicurezzaDrive').importaLavoro(Lavori.perId.get(lavoroId)).catch((e) => console.error(e));
  return { lavoroId, clienteNuovo, emailInviata, conCliente: Boolean(cliente) };
}

function scartaLavoro(id) { q.statoProposta.run('scartata', id); }

// ------------------------------------------------------------------ ricevute

/**
 * Legge i PDF nuovi delle pratiche visibili di un lavoro (o di tutti) e crea le proposte.
 * Per ogni pratica tiene la ricevuta più recente fra quelle nuove.
 */
const tappe = require('./tappe');

async function scansionaRicevute(lavoro) {
  const elenco = lavoro ? [lavoro] : Lavori.tutti.all();
  let create = 0;
  for (const l of elenco) {
    for (const p of await pratiche.sincronizza(l)) {
      if (!p.esiste) continue;
      let migliore = null;
      const integrazioni = [];
      for (const f of await archivio.documentiPratica(l, p.cartella)) {
        if (!/\.pdf$/i.test(f.nome)) continue;
        const mtime = new Date(f.modificato).getTime();
        const visto = q.fileLetto.get(p.id, f.percorso);
        if (visto && visto.modificato === mtime) continue;
        q.segnaLetto.run(p.id, f.percorso, mtime);
        const abs = archivio.fileDocumento(l, p.cartella, f.percorso);
        if (!abs || fs.statSync(abs).size > 15 * 1024 * 1024) continue;
        let esito = null;
        try { esito = await ricevute.analizza(abs, f.nome); } catch (e) { console.error(`Lettura ${f.percorso}:`, e.message); }
        if (!esito) continue;
        // Fase: dal contenuto della ricevuta (oggetto, nome del file) o dalla cartella in cui sta
        const daCartella = tappe.faseCartella(f.percorso);
        const fase = esito.fase && esito.fase !== 'presentazione' ? esito.fase : daCartella;
        if (fase) {
          // Integrazione, inizio o fine lavori: tappa a parte, presentazione e protocollo della pratica restano quelli iniziali.
          // Una ricevuta «di presentazione» di un altro ente dentro la cartella di un'integrazione non conta (es. deposito sismico).
          if (!['comune', 'suap', 'sismica'].includes(esito.tipo) || (esito.fase === 'presentazione' && esito.tipo === 'sismica')) continue;
          if (Pratiche.tappaUguale.get(p.id, fase, esito.data, esito.protocollo)) continue;
          integrazioni.push({ ...esito, stato: tappe.FASI[fase].stato, file: f.percorso });
          continue;
        }
        const chiave = esito.data || new Date(mtime).toISOString().slice(0, 10);
        if (!migliore || chiave >= migliore.chiave) migliore = { ...esito, file: f.percorso, chiave };
      }
      // Prima la presentazione principale, poi integrazioni, inizio e fine lavori in ordine di data
      const nuove = [];
      const giaUguale = migliore && p.stato === migliore.stato && (p.data || null) === (migliore.data || null) && (p.protocollo || null) === (migliore.protocollo || null);
      if (migliore && !giaUguale) {
        const { lastInsertRowid } = q.inserisciPropStato.run(p.id, migliore.file, migliore.tipo, migliore.stato, migliore.data, migliore.protocollo);
        q.scartaAltre.run(p.id, Number(lastInsertRowid));
        nuove.push(Number(lastInsertRowid));
      }
      for (const i of integrazioni.sort((a, b) => String(a.data).localeCompare(String(b.data)))) {
        nuove.push(Number(q.inserisciPropStato.run(p.id, i.file, i.tipo, i.stato, i.data, i.protocollo).lastInsertRowid));
      }
      create += nuove.length;
      if (AUTO) for (const id of nuove) await applicaStato(id, null).catch((e) => console.error(e));
    }
  }
  return create;
}

/** Applica una proposta di stato: aggiorna la pratica, il diario e avvisa il cliente. */
async function applicaStato(id, req, { email = true } = {}) {
  const ps = q.propStato.get(id);
  if (!ps || ps.stato_proposta !== 'nuova') throw new Error('Proposta non trovata o già gestita');
  const p = db.prepare('SELECT * FROM pratiche WHERE id = ?').get(ps.pratica_id);
  const lavoro = Lavori.perId.get(p.lavoro_id);
  const fase = tappe.STATI[ps.stato];
  const integrazione = Boolean(fase);
  if (fase) {
    if (!Pratiche.tappaUguale.get(p.id, fase, ps.data, ps.protocollo)) Pratiche.aggiungiTappa.run(p.id, fase, ps.data, ps.protocollo, ps.file);
  } else {
    Pratiche.aggiorna.run({
      id: p.id, lavoro_id: p.lavoro_id, stato: ps.stato, data: ps.data,
      protocollo: ps.protocollo || p.protocollo, nota: p.nota, visibile: p.visibile,
    });
  }
  q.esitoPropStato.run('applicata', id);
  Lavori.tocca.run(lavoro.id);
  const formatta = (d) => d.split('-').reverse().join('/');
  const nome = pratiche.nomeVisibile(p.cartella);
  const descr = pratiche.descriviStato({ stato: ps.stato, data: ps.data }, formatta);
  const prot = ps.protocollo ? `, protocollo n. ${ps.protocollo}` : '';
  let esito = { inviati: 0, falliti: 0 };
  if (p.visibile) Aggiornamenti.inserisci.run(lavoro.id, `${nome}: ${descr.toLowerCase()}${prot}.`);
  // Email a chi vede la pratica con il proprio ruolo (proprietario, agenzia, impresa)
  if (email && (p.visibile || p.visibile_agenzia || p.visibile_impresa)) {
    esito = await notifiche.avvisaStatoPratica(req, lavoro, nome, { stato: ps.stato, data: ps.data, protocollo: integrazione ? ps.protocollo : ps.protocollo || p.protocollo }, p);
  }
  return esito;
}

function scartaStato(id) { q.esitoPropStato.run('scartata', id); }

/** Giro periodico: nuovi lavori e ricevute. */
let inCorso = false;
async function giro() {
  if (inCorso) return;
  inCorso = true;
  try {
    await scansionaNuoviLavori();
    await scansionaRicevute();
    await require('./sicurezzaDrive').importaTutti();
  } catch (e) {
    console.error('Automazioni:', e);
  } finally {
    inCorso = false;
  }
}

function avvia() {
  const minuti = Number(process.env.AUTOMAZIONI_MINUTI) || 10;
  setTimeout(giro, 5000).unref();
  setInterval(giro, minuti * 60 * 1000).unref();
}

module.exports = {
  leggiSchedaCliente, codiceETitolo, scansionaNuoviLavori, confermaLavoro, scartaLavoro,
  scansionaRicevute, applicaStato, scartaStato, giro, avvia,
  proposteLavori: () => q.proposteNuove.all(),
  proposteStato: () => q.propStatoNuove.all(),
  proposteStatoLavoro: (id) => q.propStatoPerLavoro.all(id),
};
