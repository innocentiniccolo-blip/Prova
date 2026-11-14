'use strict';
/** Pannello dello studio: gestione clienti, lavori, documenti e aggiornamenti. */
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const auth = require('../auth');
const archivio = require('../archivio');
const pratiche = require('../pratiche');
const automazioni = require('../automazioni');
const posta = require('../posta');
const { inviaBenvenuto, avvisaClienti } = require('../notifiche');
const { db, Lavori, Utenti, Pratiche, Aggiornamenti, Accessi } = require('../modelli');
const { inviaFile, anteprimaPossibile } = require('../invio-file');

const router = express.Router();
router.use(auth.richiediAdmin);

const tmpDir = path.join(config.datiDir, 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });
const upload = multer({ dest: tmpDir, limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 30 } });

const testo = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
const dataONull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);
const flash = (req, tipo, msg) => { req.session.flash = { tipo, msg }; };

function trovaLavoro(req, res, next) {
  const lavoro = Lavori.perId.get(Number(req.params.id));
  if (!lavoro) return res.status(404).render('errore', { titolo: 'Lavoro non trovato', messaggio: '' });
  req.lavoro = lavoro;
  next();
}

// ---------- Cruscotto ----------
router.get('/', async (req, res, next) => {
  try { await automazioni.scansionaNuoviLavori(); } catch (e) { console.error(e); }
  const lavori = Lavori.tutti.all();
  const perStato = {};
  for (const l of lavori) perStato[l.stato] = (perStato[l.stato] || 0) + 1;
  const clienti = Utenti.clienti.all();
  res.render('admin/cruscotto', {
    titolo: 'Studio', lavori, perStato, nClienti: clienti.length,
    proposteLavori: automazioni.proposteLavori(), proposteStato: automazioni.proposteStato(),
  });
});

// ---------- Automazioni: proposte da confermare ----------
router.post('/proposte-lavori/:id/conferma', auth.verificaCsrf, async (req, res, next) => {
  try {
    const r = await automazioni.confermaLavoro(Number(req.params.id), req);
    flash(req, 'ok', 'Lavoro creato' + (r.clienteNuovo ? (r.emailInviata ? ' e email di benvenuto inviata al cliente.' : '. Cliente creato: comunica tu le credenziali (email non inviata).') : ' e collegato al cliente già esistente.'));
    res.redirect(`/studio/lavori/${r.lavoroId}`);
  } catch (e) { flash(req, 'errore', e.message); res.redirect('/studio'); }
});
router.post('/proposte-lavori/:id/scarta', auth.verificaCsrf, (req, res) => {
  automazioni.scartaLavoro(Number(req.params.id));
  flash(req, 'ok', 'Proposta scartata: la cartella non verrà più proposta.');
  res.redirect('/studio');
});
router.post('/proposte-stato/:id/applica', auth.verificaCsrf, async (req, res) => {
  try {
    const esito = await automazioni.applicaStato(Number(req.params.id), req, { email: Boolean(req.body.email) });
    flash(req, esito.falliti ? 'errore' : 'ok', 'Stato aggiornato.' + fraseEsito(esito));
  } catch (e) { flash(req, 'errore', e.message); }
  res.redirect(req.body.torna === 'lavoro' && req.body.lavoro ? `/studio/lavori/${Number(req.body.lavoro)}` : '/studio');
});
router.post('/proposte-stato/:id/scarta', auth.verificaCsrf, (req, res) => {
  automazioni.scartaStato(Number(req.params.id));
  flash(req, 'ok', 'Proposta scartata.');
  res.redirect(req.body.torna === 'lavoro' && req.body.lavoro ? `/studio/lavori/${Number(req.body.lavoro)}` : '/studio');
});
router.post('/automazioni/esegui', auth.verificaCsrf, async (req, res) => {
  const n1 = await automazioni.scansionaNuoviLavori();
  const n2 = await automazioni.scansionaRicevute();
  flash(req, 'ok', `Controllo completato: ${n1} nuovi lavori, ${n2} nuove proposte di stato.`);
  res.redirect('/studio');
});

// ---------- Lavori ----------
function datiLavoro(body) {
  return {
    codice: testo(body.codice, 40),
    titolo: testo(body.titolo, 200),
    descrizione: testo(body.descrizione, 5000),
    indirizzo: testo(body.indirizzo, 300),
    stato: config.studio.stati.includes(body.stato) ? body.stato : config.studio.stati[0],
    cartella: archivio.normalizzaCartella(body.cartella),
    data_inizio: dataONull(body.data_inizio),
    data_fine: dataONull(body.data_fine),
    visibile: body.visibile ? 1 : 0,
  };
}

function idClienti(body) {
  return [].concat(body.clienti || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

function renderFormLavoro(res, lavoro, clientiSel, errore) {
  res.status(errore ? 400 : 200).render('admin/lavoro-form', {
    titolo: lavoro.id ? `Modifica ${lavoro.codice}` : 'Nuovo lavoro',
    lavoro, clientiSel, errore, tuttiClienti: Utenti.clienti.all(),
  });
}

router.get('/lavori/nuovo', (req, res) => {
  const codice = Lavori.prossimoCodice();
  renderFormLavoro(res, { codice, stato: config.studio.stati[0], visibile: 1, cartella: '' }, [], null);
});

function salvaClienti(lavoroId, ids) {
  Lavori.rimuoviClienti.run(lavoroId);
  for (const uid of ids) {
    const u = Utenti.perId.get(uid);
    if (u && u.ruolo === 'cliente') Lavori.aggiungiCliente.run(lavoroId, uid);
  }
}

router.post('/lavori', auth.verificaCsrf, async (req, res, next) => {
  const dati = datiLavoro(req.body);
  const clienti = idClienti(req.body);
  if (!req.body.cartella?.trim() && dati.codice && dati.titolo) {
    dati.cartella = archivio.normalizzaCartella(`${dati.codice} ${archivio.nomeSicuro(dati.titolo) || ''}`);
  }
  if (!dati.codice || !dati.titolo) return renderFormLavoro(res, { ...req.body }, clienti, 'Codice e titolo sono obbligatori.');
  if (!dati.cartella) return renderFormLavoro(res, { ...req.body }, clienti, 'Cartella sul NAS non valida.');
  try {
    db.exec('BEGIN');
    const { lastInsertRowid } = Lavori.inserisci.run(dati);
    salvaClienti(lastInsertRowid, clienti);
    db.exec('COMMIT');
    await archivio.creaStruttura(dati);
    flash(req, 'ok', 'Lavoro creato. Se la cartella sul NAS esisteva già, le sue sottocartelle compaiono qui sotto come pratiche.');
    res.redirect(`/studio/lavori/${lastInsertRowid}`);
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    if (String(e.message).includes('UNIQUE')) return renderFormLavoro(res, { ...req.body }, clienti, 'Codice o cartella già usati da un altro lavoro.');
    next(e);
  }
});

router.get('/lavori/:id', trovaLavoro, async (req, res, next) => {
  try {
    const lavoro = req.lavoro;
    const cartellaEsiste = fs.existsSync(archivio.cartellaLavoro(lavoro) || '');
    res.render('admin/lavoro', {
      titolo: `${lavoro.codice} – ${lavoro.titolo}`,
      lavoro,
      cartellaEsiste,
      pratiche: await pratiche.conDocumenti(lavoro),
      tipiPratica: archivio.tipiPratica,
      statiPratica: archivio.statiPratica,
      descriviStato: pratiche.descriviStato,
      postaAttiva: posta.attiva,
      proposteStato: automazioni.proposteStatoLavoro(lavoro.id),
      clienti: Lavori.clienti.all(lavoro.id),
      aggiornamenti: Aggiornamenti.perLavoro.all(lavoro.id),
      accessi: Accessi.perLavoro.all(lavoro.id),
      anteprimaPossibile,
    });
  } catch (e) { next(e); }
});

router.get('/lavori/:id/modifica', trovaLavoro, (req, res) => {
  renderFormLavoro(res, req.lavoro, Lavori.clienti.all(req.lavoro.id).map((c) => c.id), null);
});

router.post('/lavori/:id', trovaLavoro, auth.verificaCsrf, async (req, res, next) => {
  const dati = { ...datiLavoro(req.body), id: req.lavoro.id };
  const clienti = idClienti(req.body);
  if (!dati.codice || !dati.titolo) return renderFormLavoro(res, { ...req.body, id: req.lavoro.id }, clienti, 'Codice e titolo sono obbligatori.');
  if (!dati.cartella) return renderFormLavoro(res, { ...req.body, id: req.lavoro.id }, clienti, 'Cartella sul NAS non valida.');
  try {
    db.exec('BEGIN');
    Lavori.aggiorna.run(dati);
    salvaClienti(req.lavoro.id, clienti);
    db.exec('COMMIT');
    flash(req, 'ok', 'Lavoro aggiornato.');
    res.redirect(`/studio/lavori/${req.lavoro.id}`);
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    if (String(e.message).includes('UNIQUE')) return renderFormLavoro(res, { ...req.body, id: req.lavoro.id }, clienti, 'Codice o cartella già usati da un altro lavoro.');
    next(e);
  }
});

router.post('/lavori/:id/crea-cartelle', trovaLavoro, auth.verificaCsrf, async (req, res, next) => {
  try {
    await archivio.creaStruttura(req.lavoro);
    flash(req, 'ok', 'Cartella del lavoro creata sul NAS.');
    res.redirect(`/studio/lavori/${req.lavoro.id}`);
  } catch (e) { next(e); }
});

router.post('/lavori/:id/elimina', trovaLavoro, auth.verificaCsrf, (req, res) => {
  Lavori.elimina.run(req.lavoro.id);
  flash(req, 'ok', `Lavoro ${req.lavoro.codice} eliminato dall'app. I file sul NAS NON sono stati toccati.`);
  res.redirect('/studio');
});

// ---------- Documenti ----------
/** Rimuove sempre i file temporanei di multer a fine richiesta (anche se il CSRF fallisce). */
function pulisciTmp(req, res, next) {
  res.on('close', () => {
    for (const f of req.files || []) fs.rm(f.path, { force: true }, () => {});
  });
  next();
}

function fraseEsito(esito) {
  if (esito.falliti) return ` Attenzione: ${esito.falliti} email non sono partite, controlla le impostazioni SMTP.`;
  if (esito.inviati) return ` Cliente avvisato via email.`;
  return '';
}

function trovaPratica(req, id) {
  return Pratiche.perId.get(Number(id), req.lavoro.id);
}

router.post('/lavori/:id/documenti', trovaLavoro, pulisciTmp, upload.array('file'), auth.verificaCsrf, async (req, res, next) => {
  const files = req.files || [];
  try {
    const pratica = trovaPratica(req, req.body.pratica);
    if (!pratica) throw new Error('Pratica non valida');
    const nomi = [];
    for (const f of files) {
      // multer decodifica i nomi come latin1: riconverte in UTF-8 (accenti, ecc.)
      const originale = Buffer.from(f.originalname, 'latin1').toString('utf8');
      nomi.push(await archivio.salvaUpload(req.lavoro, pratica.cartella, f.path, originale));
    }
    if (nomi.length) {
      Lavori.tocca.run(req.lavoro.id);
      if (req.body.annuncia && pratica.visibile) {
        Aggiornamenti.inserisci.run(req.lavoro.id, `${pratiche.nomeVisibile(pratica.cartella)}: nuovi documenti (${nomi.join(', ')})`);
      }
    }
    let esito = { inviati: 0, falliti: 0 };
    if (nomi.length && req.body.email && pratica.visibile) {
      const nome = pratiche.nomeVisibile(pratica.cartella);
      esito = await avvisaClienti(req, req.lavoro, `Nuovi documenti: ${nome} – ${req.lavoro.titolo}`,
        `sono disponibili nuovi documenti per la pratica «${nome}» del lavoro «${req.lavoro.titolo}»:\n\n${nomi.map((n) => `- ${n}`).join('\n')}`);
    }
    flash(req, esito.falliti ? 'errore' : 'ok', (nomi.length ? `Caricati ${nomi.length} file in «${pratica.cartella}».` : 'Nessun file selezionato.') + fraseEsito(esito));
    res.redirect(`/studio/lavori/${req.lavoro.id}#pratica-${pratica.id}`);
  } catch (e) { next(e); }
});

router.get('/lavori/:id/file', trovaLavoro, (req, res) => {
  const pratica = trovaPratica(req, req.query.p);
  const abs = pratica && archivio.fileDocumento(req.lavoro, pratica.cartella, String(req.query.f || ''));
  if (!abs) return res.status(404).render('errore', { titolo: 'File non trovato', messaggio: '' });
  inviaFile(res, abs, { scarica: req.query.scarica === '1' });
});

router.post('/lavori/:id/documenti/elimina', trovaLavoro, auth.verificaCsrf, async (req, res, next) => {
  try {
    const pratica = trovaPratica(req, req.body.p);
    const ok = Boolean(pratica) && await archivio.eliminaFile(req.lavoro, pratica.cartella, String(req.body.f || ''));
    flash(req, ok ? 'ok' : 'errore', ok ? 'File eliminato.' : 'File non trovato.');
    res.redirect(`/studio/lavori/${req.lavoro.id}${pratica ? `#pratica-${pratica.id}` : ''}`);
  } catch (e) { next(e); }
});

// ---------- Pratiche (sottocartelle del lavoro) ----------
router.post('/lavori/:id/pratiche', trovaLavoro, auth.verificaCsrf, async (req, res, next) => {
  try {
    const nome = testo(req.body.altro, 100) || testo(req.body.tipo, 100);
    if (!nome) {
      flash(req, 'errore', 'Scegli un tipo di pratica o scrivi un nome.');
      return res.redirect(`/studio/lavori/${req.lavoro.id}#pratiche`);
    }
    const cartella = await archivio.creaCartellaPratica(req.lavoro, nome);
    await pratiche.sincronizza(req.lavoro);
    Lavori.tocca.run(req.lavoro.id);
    flash(req, 'ok', `Pratica «${cartella}» aggiunta: la cartella è stata creata sul NAS.`);
    res.redirect(`/studio/lavori/${req.lavoro.id}#pratiche`);
  } catch (e) {
    if (e.message === 'Nome pratica non valido') {
      flash(req, 'errore', 'Nome della pratica non valido.');
      return res.redirect(`/studio/lavori/${req.lavoro.id}#pratiche`);
    }
    next(e);
  }
});

router.post('/lavori/:id/pratiche/:pid', trovaLavoro, auth.verificaCsrf, async (req, res, next) => {
  try {
  const pratica = trovaPratica(req, req.params.pid);
  if (!pratica) return res.status(404).render('errore', { titolo: 'Pratica non trovata', messaggio: '' });
  const nuova = {
    id: pratica.id,
    lavoro_id: req.lavoro.id,
    stato: archivio.statiPratica.includes(req.body.stato) ? req.body.stato : pratica.stato,
    data: dataONull(req.body.data),
    protocollo: testo(req.body.protocollo, 100) || null,
    nota: testo(req.body.nota, 2000) || null,
    visibile: req.body.visibile ? 1 : 0,
  };
  Pratiche.aggiorna.run(nuova);
  Lavori.tocca.run(req.lavoro.id);
  const cambiata = nuova.stato !== pratica.stato || nuova.data !== pratica.data || nuova.protocollo !== pratica.protocollo;
  const nome = pratiche.nomeVisibile(pratica.cartella);
  let frase = `${nome}: ${pratiche.descriviStato(nuova, req.app.locals.data).toLowerCase()}`;
  if (nuova.protocollo) frase += `, protocollo n. ${nuova.protocollo}`;
  if (req.body.annuncia && nuova.visibile && cambiata) Aggiornamenti.inserisci.run(req.lavoro.id, frase + '.');
  let esito = { inviati: 0, falliti: 0 };
  if (req.body.email && nuova.visibile && cambiata) {
    let corpo = `la pratica «${nome}» del lavoro «${req.lavoro.titolo}» è stata aggiornata:\n\n${pratiche.descriviStato(nuova, req.app.locals.data)}`;
    if (nuova.protocollo) corpo += ` – protocollo n. ${nuova.protocollo}`;
    if (nuova.nota) corpo += `\n\nNota dello studio: ${nuova.nota}`;
    esito = await avvisaClienti(req, req.lavoro, `Aggiornamento pratica: ${nome} – ${req.lavoro.titolo}`, corpo);
  }
  flash(req, esito.falliti ? 'errore' : 'ok', `Pratica «${pratica.cartella}» aggiornata.` + fraseEsito(esito));
  res.redirect(`/studio/lavori/${req.lavoro.id}#pratica-${pratica.id}`);
  } catch (e) { next(e); }
});

router.post('/lavori/:id/pratiche/:pid/elimina', trovaLavoro, auth.verificaCsrf, (req, res) => {
  const pratica = trovaPratica(req, req.params.pid);
  if (pratica) Pratiche.elimina.run(pratica.id, req.lavoro.id);
  flash(req, 'ok', 'Pratica tolta dall\'elenco. Nessun file sul NAS è stato toccato.');
  res.redirect(`/studio/lavori/${req.lavoro.id}#pratiche`);
});

// ---------- Aggiornamenti (diario visibile al cliente) ----------
router.post('/lavori/:id/aggiornamenti', trovaLavoro, auth.verificaCsrf, (req, res) => {
  const t = testo(req.body.testo, 5000);
  if (t) {
    Aggiornamenti.inserisci.run(req.lavoro.id, t);
    Lavori.tocca.run(req.lavoro.id);
  }
  res.redirect(`/studio/lavori/${req.lavoro.id}#aggiornamenti`);
});

router.post('/lavori/:id/aggiornamenti/:aid/elimina', trovaLavoro, auth.verificaCsrf, (req, res) => {
  Aggiornamenti.elimina.run(Number(req.params.aid), req.lavoro.id);
  res.redirect(`/studio/lavori/${req.lavoro.id}#aggiornamenti`);
});

// ---------- Clienti ----------
router.get('/clienti', (req, res) => {
  res.render('admin/clienti', { titolo: 'Clienti', clienti: Utenti.clienti.all() });
});

router.get('/clienti/nuovo', (req, res) => {
  res.render('admin/cliente-form', { postaAttiva: posta.attiva, titolo: 'Nuovo cliente', cliente: { attivo: 1 }, errore: null, lavori: [] });
});

function emailValida(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

router.post('/clienti', auth.verificaCsrf, async (req, res, next) => {
  const cliente = { nome: testo(req.body.nome, 200), email: testo(req.body.email, 200).toLowerCase(), telefono: testo(req.body.telefono, 50), attivo: 1 };
  const errore = (msg) => res.status(400).render('admin/cliente-form', { postaAttiva: posta.attiva, titolo: 'Nuovo cliente', cliente, errore: msg, lavori: [] });
  if (!cliente.nome || !emailValida(cliente.email)) return errore('Nome ed email valida sono obbligatori.');
  if (Utenti.perEmail.get(cliente.email)) return errore('Esiste già un utente con questa email.');
  try {
    const pw = auth.passwordTemporanea();
    const { lastInsertRowid } = Utenti.inserisci.run(cliente.email, await auth.hashPassword(pw), cliente.nome, cliente.telefono, 'cliente');
    req.session.credenziali = { email: cliente.email, password: pw };
    if (req.body.benvenuto && posta.attiva) {
      try {
        await inviaBenvenuto(req, { id: Number(lastInsertRowid), ...cliente });
        flash(req, 'ok', `Email di benvenuto inviata a ${cliente.email}.`);
      } catch (err) {
        console.error(err);
        flash(req, 'errore', 'Cliente creato, ma l\'email non è partita: controlla le impostazioni SMTP. Comunica a voce le credenziali qui sotto.');
      }
    }
    res.redirect(`/studio/clienti/${lastInsertRowid}`);
  } catch (e) { next(e); }
});

router.post('/clienti/:id/invia-benvenuto', auth.verificaCsrf, async (req, res) => {
  const cliente = Utenti.perId.get(Number(req.params.id));
  if (!cliente || cliente.ruolo !== 'cliente') return res.redirect('/studio/clienti');
  if (!posta.attiva) {
    flash(req, 'errore', 'L\'invio delle email non è configurato.');
  } else {
    try {
      await inviaBenvenuto(req, cliente);
      flash(req, 'ok', `Email con il link per la password inviata a ${cliente.email}.`);
    } catch (err) {
      console.error(err);
      flash(req, 'errore', 'L\'email non è partita: controlla le impostazioni SMTP.');
    }
  }
  res.redirect(`/studio/clienti/${cliente.id}`);
});

router.get('/clienti/:id', (req, res) => {
  const cliente = Utenti.perId.get(Number(req.params.id));
  if (!cliente || cliente.ruolo !== 'cliente') return res.status(404).render('errore', { titolo: 'Cliente non trovato', messaggio: '' });
  const credenziali = req.session.credenziali;
  delete req.session.credenziali; // mostrate una sola volta
  res.render('admin/cliente-form', { postaAttiva: posta.attiva, titolo: cliente.nome, cliente, errore: null, credenziali, lavori: Utenti.lavori.all(cliente.id) });
});

router.post('/clienti/:id', auth.verificaCsrf, (req, res) => {
  const cliente = Utenti.perId.get(Number(req.params.id));
  if (!cliente || cliente.ruolo !== 'cliente') return res.status(404).render('errore', { titolo: 'Cliente non trovato', messaggio: '' });
  const nuovo = { ...cliente, nome: testo(req.body.nome, 200), email: testo(req.body.email, 200).toLowerCase(), telefono: testo(req.body.telefono, 50), attivo: req.body.attivo ? 1 : 0 };
  const altro = Utenti.perEmail.get(nuovo.email);
  let errore = null;
  if (!nuovo.nome || !emailValida(nuovo.email)) errore = 'Nome ed email valida sono obbligatori.';
  else if (altro && altro.id !== cliente.id) errore = 'Esiste già un utente con questa email.';
  if (errore) return res.status(400).render('admin/cliente-form', { postaAttiva: posta.attiva, titolo: cliente.nome, cliente: nuovo, errore, lavori: Utenti.lavori.all(cliente.id) });
  Utenti.aggiorna.run(nuovo.email, nuovo.nome, nuovo.telefono, nuovo.attivo, cliente.id);
  if (!nuovo.attivo) Utenti.terminaSessioni.run(cliente.id);
  flash(req, 'ok', 'Cliente aggiornato.');
  res.redirect(`/studio/clienti/${cliente.id}`);
});

router.post('/clienti/:id/reimposta-password', auth.verificaCsrf, async (req, res, next) => {
  try {
    const cliente = Utenti.perId.get(Number(req.params.id));
    if (!cliente || cliente.ruolo !== 'cliente') return res.redirect('/studio/clienti');
    const pw = auth.passwordTemporanea();
    Utenti.impostaPassword.run(await auth.hashPassword(pw), cliente.id);
    Utenti.terminaSessioni.run(cliente.id);
    req.session.credenziali = { email: cliente.email, password: pw };
    res.redirect(`/studio/clienti/${cliente.id}`);
  } catch (e) { next(e); }
});

router.post('/clienti/:id/elimina', auth.verificaCsrf, (req, res) => {
  Utenti.terminaSessioni.run(Number(req.params.id));
  Utenti.elimina.run(Number(req.params.id));
  flash(req, 'ok', 'Cliente eliminato.');
  res.redirect('/studio/clienti');
});

module.exports = router;
