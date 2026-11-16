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
const imprese = require('../imprese');
const richieste = require('../richieste');
const pubblicati = require('../pubblicati');
const posta = require('../posta');
const { inviaBenvenuto, avvisaClienti, avvisaStatoPratica } = require('../notifiche');
const { db, Lavori, Utenti, Pratiche, Aggiornamenti, Accessi } = require('../modelli');
const { inviaFile, anteprimaPossibile } = require('../invio-file');
const ruoli = require('../ruoli');
const { ruoloValido } = ruoli;

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
    avvisiImprese: imprese.avvisiScadenze(),
    documentiRicevuti: richieste.Q.daControllare.all(),
    blocchi: auth.blocchiAttivi().filter((b) => !/\|(reset|profilo|configura)/.test(b.chiave) || b.chiave.includes('|profilo|')),
  });
});

// Nasconde gli avvisi della sicurezza (uno o tutti): tornano se arriva un documento nuovo
router.post('/avvisi-imprese/nascondi', auth.verificaCsrf, (req, res) => {
  const id = Number(req.body.impresa) || null;
  imprese.nascondiAvviso(id, id ? String(req.body.tipo || '') : null);
  flash(req, 'ok', id ? 'Avviso nascosto: ricompare se arriva un documento nuovo o cambia la scadenza.' : 'Avvisi nascosti: ricompaiono se arriva un documento nuovo o cambia una scadenza.');
  res.redirect('/studio');
});

// ---------- Accessi bloccati per troppi errori ----------
router.post('/blocchi/sblocca', auth.verificaCsrf, (req, res) => {
  const ok = auth.sblocca(String(req.body.chiave || '').slice(0, 300));
  flash(req, ok ? 'ok' : 'errore', ok ? 'Accesso sbloccato.' : 'Blocco non trovato (forse è già scaduto).');
  res.redirect('/studio');
});

// ---------- Automazioni: proposte da confermare ----------
router.post('/proposte-lavori/:id/conferma', auth.verificaCsrf, async (req, res, next) => {
  try {
    const r = await automazioni.confermaLavoro(Number(req.params.id), req, { email: req.body.email, nome: req.body.nome });
    flash(req, 'ok', 'Lavoro creato' + (!r.conCliente ? '. Collega il cliente da «Modifica».' : r.clienteNuovo ? (r.emailInviata ? ' e email di benvenuto inviata al cliente.' : '. Cliente creato: comunica tu le credenziali (email non inviata).') : ' e collegato al cliente già esistente.'));
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
  const n3 = await require('../sicurezzaDrive').importaTutti();
  flash(req, 'ok', `Controllo completato: ${n1} nuovi lavori, ${n2} nuove proposte di stato` + (n3 ? `, ${n3} documenti di imprese della sicurezza.` : '.'));
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

/** Clienti scelti nel modulo con il loro ruolo: [{ id, ruolo }] (campo "ruolo_<id>"; vuoto = non collegato). */
function idClienti(body) {
  const out = [];
  for (const [k, v] of Object.entries(body)) {
    const m = k.match(/^ruolo_(\d+)$/);
    if (m && ruoli.RUOLI[v]) out.push({ id: Number(m[1]), ruolo: v });
  }
  // Compatibilità con il vecchio modulo a spunte
  for (const id of [].concat(body.clienti || []).map(Number)) if (id > 0 && !out.some((c) => c.id === id)) out.push({ id, ruolo: 'proprietario' });
  return out;
}

/** Un'agenzia vede i documenti di un immobile solo con il consenso del proprietario, registrato con la data. */
function controllaConsenso(lavoroId, clienti, body) {
  const nuoveAgenzie = clienti.filter((c) => c.ruolo === 'agenzia'
    && !(lavoroId && Lavori.ruoloCliente.get(lavoroId, c.id)?.consenso_il));
  if (nuoveAgenzie.length && body.consenso_agenzia !== '1') {
    return 'Per collegare un\'agenzia conferma di avere l\'autorizzazione del proprietario a mostrarle i documenti.';
  }
  return null;
}

function renderFormLavoro(res, lavoro, clientiSel, errore) {
  res.status(errore ? 400 : 200).render('admin/lavoro-form', {
    titolo: lavoro.id ? `Modifica ${lavoro.codice}` : 'Nuovo lavoro',
    lavoro, clientiSel, errore, tuttiClienti: Utenti.clienti.all(), cartelleLibere: cartelleLibere(lavoro.cartella), RUOLI: ruoli.RUOLI,
  });
}

/** Cartelle dei lavori presenti nell'archivio e non ancora collegate a un lavoro (per sceglierle dal modulo). */
function cartelleLibere(attuale) {
  let nomi = [];
  try {
    nomi = require('node:fs').readdirSync(config.archivioDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
  } catch { return []; }
  const usate = new Set(db.prepare('SELECT cartella FROM lavori').all().map((r) => r.cartella));
  return nomi.filter((n) => !usate.has(n) || n === attuale).sort((a, b) => a.localeCompare(b, 'it'));
}

router.get('/lavori/nuovo', (req, res) => {
  const codice = Lavori.prossimoCodice();
  renderFormLavoro(res, { codice, stato: config.studio.stati[0], visibile: 1, cartella: '' }, [], null);
});

function salvaClienti(lavoroId, scelti) {
  const prima = new Map(Lavori.clienti.all(lavoroId).map((c) => [c.id, c]));
  Lavori.rimuoviClienti.run(lavoroId);
  const ora = new Date().toISOString().slice(0, 19).replace('T', ' ');
  for (const { id, ruolo } of scelti) {
    const u = Utenti.perId.get(id);
    if (!u || u.ruolo !== 'cliente') continue;
    const consenso = ruolo === 'agenzia' ? (prima.get(id)?.ruolo === 'agenzia' && prima.get(id)?.consenso_il) || ora : null;
    Lavori.aggiungiConRuolo.run(lavoroId, id, ruoloValido(ruolo), consenso);
  }
}

router.post('/lavori', auth.verificaCsrf, async (req, res, next) => {
  const dati = datiLavoro(req.body);
  const clienti = idClienti(req.body);
  if (config.archivioSolaLettura && !req.body.cartella?.trim()) {
    return renderFormLavoro(res, { ...req.body }, clienti, 'Scegli la cartella del lavoro su Google Drive (prima condividila con l\'account di servizio).');
  }
  if (!req.body.cartella?.trim() && dati.codice && dati.titolo) {
    dati.cartella = archivio.normalizzaCartella(`${dati.codice} ${archivio.nomeSicuro(dati.titolo) || ''}`);
  }
  if (!dati.codice || !dati.titolo) return renderFormLavoro(res, { ...req.body }, clienti, 'Codice e titolo sono obbligatori.');
  if (!dati.cartella) return renderFormLavoro(res, { ...req.body }, clienti, 'Cartella non valida.');
  const erroreConsenso = controllaConsenso(null, clienti, req.body);
  if (erroreConsenso) return renderFormLavoro(res, { ...req.body }, clienti, erroreConsenso);
  try {
    db.exec('BEGIN');
    const { lastInsertRowid } = Lavori.inserisci.run(dati);
    salvaClienti(lastInsertRowid, clienti);
    db.exec('COMMIT');
    if (!config.archivioSolaLettura) await archivio.creaStruttura(dati);
    await require('../sicurezzaDrive').importaLavoro(Lavori.perId.get(lastInsertRowid)).catch((e) => console.error(e));
    flash(req, 'ok', 'Lavoro creato. Le sottocartelle della cartella del lavoro compaiono qui sotto come pratiche.');
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
      RUOLI: ruoli.RUOLI,
      consigliataAgenzia: ruoli.consigliataAgenzia,
      aggiornamenti: Aggiornamenti.perLavoro.all(lavoro.id),
      accessi: Accessi.perLavoro.all(lavoro.id),
      anteprimaPossibile,
      impreseCantiere: imprese.impreseDelLavoro(lavoro.id),
      verbali: imprese.Q.verbali.all(lavoro.id),
      richieste: richieste.elenco(lavoro.id),
      limitiRichieste: richieste.LIMITI,
      tipiVerbale: imprese.TIPI_VERBALE,
      tutteImprese: imprese.Q.tutte.all(),
      tipiDoc: imprese.TIPI,
    });
  } catch (e) { next(e); }
});

router.get('/lavori/:id/modifica', trovaLavoro, (req, res) => {
  renderFormLavoro(res, req.lavoro, Lavori.clienti.all(req.lavoro.id).map((c) => ({ id: c.id, ruolo: c.ruolo })), null);
});

router.post('/lavori/:id', trovaLavoro, auth.verificaCsrf, async (req, res, next) => {
  const dati = { ...datiLavoro(req.body), id: req.lavoro.id };
  const clienti = idClienti(req.body);
  if (!dati.codice || !dati.titolo) return renderFormLavoro(res, { ...req.body, id: req.lavoro.id }, clienti, 'Codice e titolo sono obbligatori.');
  if (!dati.cartella) return renderFormLavoro(res, { ...req.body, id: req.lavoro.id }, clienti, 'Cartella non valida.');
  const erroreConsenso = controllaConsenso(req.lavoro.id, clienti, req.body);
  if (erroreConsenso) return renderFormLavoro(res, { ...req.body, id: req.lavoro.id }, clienti, erroreConsenso);
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

router.post('/lavori/:id/crea-cartelle', soloScrittura, trovaLavoro, auth.verificaCsrf, async (req, res, next) => {
  try {
    await archivio.creaStruttura(req.lavoro);
    flash(req, 'ok', 'Cartella del lavoro creata sul NAS.');
    res.redirect(`/studio/lavori/${req.lavoro.id}`);
  } catch (e) { next(e); }
});

router.post('/lavori/:id/elimina', trovaLavoro, auth.verificaCsrf, async (req, res) => {
  Lavori.elimina.run(req.lavoro.id);
  await imprese.eliminaFileLavoro(req.lavoro.id).catch((e) => console.error(e));
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


// Con l'archivio copiato da Google Drive le cartelle e i file dei lavori si gestiscono su Drive:
// ciò che si creasse qui verrebbe cancellato alla copia successiva.
function soloScrittura(req, res, next) {
  if (!config.archivioSolaLettura) return next();
  flash(req, 'errore', 'Cartelle e file dei lavori si gestiscono su Google Drive: compaiono qui entro 5 minuti.');
  res.redirect(`/studio/lavori/${req.params.id}`);
}

function trovaPratica(req, id) {
  return Pratiche.perId.get(Number(id), req.lavoro.id);
}

router.post('/lavori/:id/documenti', soloScrittura, trovaLavoro, pulisciTmp, upload.array('file'), auth.verificaCsrf, async (req, res, next) => {
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
    // I file caricati restano privati, a meno che lo studio scelga di pubblicarli subito
    const tutti = nomi.slice();
    const bloccati = [];
    if (req.body.pubblica) {
      for (const n of tutti) { const r = pubblicati.pubblica(req.lavoro, pratica, n); if (!r.ok) bloccati.push(`${n} (${r.motivo})`); }
    }
    nomi.length = 0;
    if (req.body.pubblica) nomi.push(...tutti.filter((n) => !pubblicati.sembraSensibile(n)));
    if (nomi.length) {
      Lavori.tocca.run(req.lavoro.id);
      if (req.body.annuncia && pratica.visibile) {
        Aggiornamenti.inserisci.run(req.lavoro.id, `${pratiche.nomeVisibile(pratica.cartella)}: nuovi documenti (${nomi.join(', ')})`);
      }
    }
    const esito = { inviati: 0, falliti: 0 }; // nessuna email per i documenti: il cliente riceve solo gli aggiornamenti di stato
    flash(req, esito.falliti || bloccati.length ? 'errore' : 'ok', (tutti.length ? `Caricati ${tutti.length} file in «${pratica.cartella}»: ${nomi.length ? nomi.length + ' pubblicati per il cliente' : 'restano privati finché non li pubblichi'}.` : 'Nessun file selezionato.')
      + (bloccati.length ? ` Non pubblicati perché sembrano sensibili: ${bloccati.join('; ')}.` : '') + fraseEsito(esito));
    res.redirect(`/studio/lavori/${req.lavoro.id}#pratica-${pratica.id}`);
  } catch (e) { next(e); }
});

router.get('/lavori/:id/file', trovaLavoro, (req, res) => {
  const pratica = trovaPratica(req, req.query.p);
  const abs = pratica && archivio.fileDocumento(req.lavoro, pratica.cartella, String(req.query.f || ''));
  if (!abs) return res.status(404).render('errore', { titolo: 'File non trovato', messaggio: '' });
  inviaFile(res, abs, { scarica: req.query.scarica === '1' });
});

// Pubblica o nasconde un documento (o tutti quelli non sensibili della pratica) per il cliente
router.post('/lavori/:id/documenti/visibilita', trovaLavoro, auth.verificaCsrf, async (req, res, next) => {
  try {
    const pratica = trovaPratica(req, req.body.p);
    if (!pratica) { flash(req, 'errore', 'Pratica non valida.'); return res.redirect(`/studio/lavori/${req.lavoro.id}`); }
    const rel = String(req.body.f || '');
    if (req.body.azione === 'nascondi') {
      pubblicati.nascondi(pratica, rel);
      flash(req, 'ok', 'Documento nascosto al cliente.');
    } else if (req.body.azione === 'tutti') {
      const file = await archivio.documentiPratica(req.lavoro, pratica.cartella);
      let n = 0; let saltati = 0;
      for (const f of file) { if (pubblicati.pubblica(req.lavoro, pratica, f.percorso).ok) n++; else saltati++; }
      flash(req, 'ok', `Pubblicati ${n} documenti.` + (saltati ? ` ${saltati} lasciati privati perché sembrano contenere dati sensibili.` : ''));
    } else {
      const r = pubblicati.pubblica(req.lavoro, pratica, rel);
      flash(req, r.ok ? 'ok' : 'errore', r.ok ? 'Documento pubblicato: ora il cliente può vederlo.' : `Non pubblicato: ${r.motivo}. I documenti sensibili non vengono mai mostrati nell'area clienti.`);
    }
    res.redirect(`/studio/lavori/${req.lavoro.id}#pratica-${pratica.id}`);
  } catch (e) { next(e); }
});

router.post('/lavori/:id/documenti/elimina', soloScrittura, trovaLavoro, auth.verificaCsrf, async (req, res, next) => {
  try {
    const pratica = trovaPratica(req, req.body.p);
    const ok = Boolean(pratica) && await archivio.eliminaFile(req.lavoro, pratica.cartella, String(req.body.f || ''));
    flash(req, ok ? 'ok' : 'errore', ok ? 'File eliminato.' : 'File non trovato.');
    res.redirect(`/studio/lavori/${req.lavoro.id}${pratica ? `#pratica-${pratica.id}` : ''}`);
  } catch (e) { next(e); }
});

// ---------- Pratiche (sottocartelle del lavoro) ----------
// Sceglie in un colpo solo quali cartelle (pratiche) del lavoro vede il cliente
router.post('/lavori/:id/pratiche-visibili', trovaLavoro, auth.verificaCsrf, (req, res) => {
  const set = (k) => new Set([].concat(req.body[k] || []).map(Number));
  const [prop, agz, imp] = [set('visibili'), set('visibili_agenzia'), set('visibili_impresa')];
  let n = 0;
  for (const p of Pratiche.perLavoro.all(req.lavoro.id)) {
    const v = [prop.has(p.id) ? 1 : 0, agz.has(p.id) ? 1 : 0, imp.has(p.id) ? 1 : 0];
    if (v[0] !== p.visibile || v[1] !== p.visibile_agenzia || v[2] !== p.visibile_impresa) {
      Pratiche.visibilitaRuoli.run(...v, p.id, p.lavoro_id); n++;
    }
  }
  flash(req, 'ok', n ? 'Visibilità aggiornata.' : 'Nessuna modifica: le cartelle spuntate erano già visibili.');
  res.redirect(`/studio/lavori/${req.lavoro.id}#pratiche`);
});

router.post('/lavori/:id/pratiche', soloScrittura, trovaLavoro, auth.verificaCsrf, async (req, res, next) => {
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
  const perAvviso = { ...pratica, visibile: nuova.visibile };
  if (req.body.email && cambiata && (nuova.visibile || pratica.visibile_agenzia || pratica.visibile_impresa)) {
    esito = await avvisaStatoPratica(req, req.lavoro, nome, nuova, perAvviso);
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
  const daEliminare = Utenti.perId.get(Number(req.params.id));
  Utenti.terminaSessioni.run(Number(req.params.id));
  if (daEliminare && daEliminare.ruolo === 'cliente') auth.azzeraEmail(daEliminare.email);
  Utenti.elimina.run(Number(req.params.id));
  flash(req, 'ok', 'Cliente eliminato: account, accessi ai lavori e registro delle consultazioni non sono più collegati a lui. I documenti delle pratiche restano nelle cartelle dei lavori.');
  res.redirect('/studio/clienti');
});

// ---------- Sicurezza cantiere: imprese e loro documenti ----------
const datiImpresa = (b) => ({
  ragione_sociale: testo(b.ragione_sociale, 200), piva: testo(b.piva, 20) || null, sede: testo(b.sede, 300) || null,
  pec: testo(b.pec, 160) || null, telefono: testo(b.telefono, 40) || null, autonomo: b.autonomo ? 1 : 0,
  nota: testo(b.nota, 2000) || null,
});
function trovaImpresa(req, res, next) {
  const i = imprese.Q.perId.get(Number(req.params.iid));
  if (!i) return res.status(404).render('errore', { titolo: 'Impresa non trovata', messaggio: '' });
  req.impresa = i;
  next();
}

router.get('/imprese', (req, res) => {
  const elenco = imprese.Q.tutte.all().map((i) => ({ ...i, riepilogo: imprese.riepilogo(i.id) }));
  res.render('admin/imprese', { titolo: 'Imprese', imprese: elenco, tipiDoc: imprese.TIPI });
});

router.post('/imprese', auth.verificaCsrf, (req, res) => {
  const d = datiImpresa(req.body);
  if (!d.ragione_sociale) { flash(req, 'errore', 'Indica la ragione sociale.'); return res.redirect('/studio/imprese'); }
  const id = Number(imprese.Q.inserisci.run(d).lastInsertRowid);
  const lavoroId = Number(req.body.lavoro) || 0;
  if (lavoroId && Lavori.perId.get(lavoroId)) {
    imprese.Q.collega.run(lavoroId, id, testo(req.body.ruolo, 100) || null, 1);
    flash(req, 'ok', `Impresa «${d.ragione_sociale}» creata e aggiunta al cantiere. Carica ora i suoi documenti.`);
  } else flash(req, 'ok', `Impresa «${d.ragione_sociale}» creata. Carica ora i suoi documenti.`);
  res.redirect(`/studio/imprese/${id}`);
});

router.get('/imprese/:iid', trovaImpresa, (req, res) => {
  res.render('admin/impresa', {
    titolo: req.impresa.ragione_sociale, impresa: req.impresa, tipiDoc: imprese.TIPI,
    documenti: imprese.Q.documenti.all(req.impresa.id).map((d) => ({ ...d, stato: imprese.statoDocumento(d) })),
    riepilogo: imprese.riepilogo(req.impresa.id), lavori: imprese.Q.lavoriImpresa.all(req.impresa.id),
    creditiMinimi: imprese.CREDITI_MINIMI,
  });
});

router.post('/imprese/:iid', trovaImpresa, auth.verificaCsrf, (req, res) => {
  const d = datiImpresa(req.body);
  if (!d.ragione_sociale) d.ragione_sociale = req.impresa.ragione_sociale;
  imprese.Q.aggiorna.run({ ...d, id: req.impresa.id });
  flash(req, 'ok', 'Dati dell\'impresa salvati.');
  res.redirect(`/studio/imprese/${req.impresa.id}`);
});

router.post('/imprese/:iid/elimina', trovaImpresa, auth.verificaCsrf, async (req, res, next) => {
  try {
    await imprese.eliminaImpresa(req.impresa.id);
    flash(req, 'ok', 'Impresa eliminata con i suoi documenti.');
    res.redirect('/studio/imprese');
  } catch (e) { next(e); }
});

router.post('/imprese/:iid/documenti', trovaImpresa, pulisciTmp, upload.array('file', 1), auth.verificaCsrf, async (req, res, next) => {
  try {
    const f = (req.files || [])[0];
    const b = req.body;
    const crediti = b.crediti === '' || b.crediti == null ? null : Number.parseInt(b.crediti, 10);
    if (!f && b.tipo !== 'patente') { flash(req, 'errore', 'Seleziona il file da caricare.'); return res.redirect(`/studio/imprese/${req.impresa.id}`); }
    await imprese.salvaDocumento(req.impresa.id, {
      tipo: b.tipo, descrizione: testo(b.descrizione, 200), rilascio: dataONull(b.rilascio), scadenza: dataONull(b.scadenza),
      numero: testo(b.numero, 100), crediti: Number.isInteger(crediti) && crediti >= 0 && crediti <= 200 ? crediti : null,
    }, f && f.path, f && Buffer.from(f.originalname, 'latin1').toString('utf8'));
    flash(req, 'ok', `${imprese.TIPI[b.tipo] || 'Documento'} registrato.`);
    res.redirect(`/studio/imprese/${req.impresa.id}`);
  } catch (e) { next(e); }
});

router.get('/imprese/:iid/documenti/:did', trovaImpresa, (req, res) => {
  const abs = imprese.percorsoFile(imprese.Q.documento.get(Number(req.params.did), req.impresa.id));
  if (!abs) return res.status(404).render('errore', { titolo: 'File non trovato', messaggio: '' });
  inviaFile(res, abs, { scarica: req.query.scarica === '1' });
});

router.post('/imprese/:iid/documenti/:did/elimina', trovaImpresa, auth.verificaCsrf, async (req, res, next) => {
  try {
    const ok = await imprese.eliminaDocumento(req.impresa.id, Number(req.params.did));
    flash(req, ok ? 'ok' : 'errore', ok ? 'Documento eliminato.' : 'Documento non trovato.');
    res.redirect(`/studio/imprese/${req.impresa.id}`);
  } catch (e) { next(e); }
});

// Imprese presenti nel cantiere di un lavoro
router.post('/lavori/:id/imprese', trovaLavoro, auth.verificaCsrf, (req, res) => {
  const i = imprese.Q.perId.get(Number(req.body.impresa));
  if (!i) flash(req, 'errore', 'Scegli un\'impresa dall\'elenco.');
  else {
    imprese.Q.collega.run(req.lavoro.id, i.id, testo(req.body.ruolo, 100) || null, req.body.visibile ? 1 : 0);
    flash(req, 'ok', `«${i.ragione_sociale}» aggiunta al cantiere.`);
  }
  res.redirect(`/studio/lavori/${req.lavoro.id}#sicurezza`);
});

router.post('/lavori/:id/imprese/:iid', trovaLavoro, auth.verificaCsrf, (req, res) => {
  const iid = Number(req.params.iid);
  if (imprese.Q.collegamento.get(req.lavoro.id, iid)) {
    if (req.body.azione === 'togli') imprese.Q.scollega.run(req.lavoro.id, iid);
    else imprese.Q.collega.run(req.lavoro.id, iid, testo(req.body.ruolo, 100) || null, req.body.visibile ? 1 : 0);
    flash(req, 'ok', req.body.azione === 'togli' ? 'Impresa tolta dal cantiere.' : 'Impresa aggiornata.');
  }
  res.redirect(`/studio/lavori/${req.lavoro.id}#sicurezza`);
});

// Attiva o disattiva la sezione sicurezza per un lavoro (i dati restano salvati)
router.post('/lavori/:id/sicurezza', trovaLavoro, auth.verificaCsrf, (req, res) => {
  const attiva = req.body.attiva === '1' ? 1 : 0;
  imprese.Q.impostaSicurezza.run(attiva, req.lavoro.id);
  flash(req, 'ok', attiva ? 'Sezione sicurezza cantiere attivata per questo lavoro.' : 'Sezione sicurezza disattivata: il cliente non la vede più. I dati restano salvati.');
  res.redirect(`/studio/lavori/${req.lavoro.id}#sicurezza`);
});

// Verbali di cantiere
router.post('/lavori/:id/verbali', trovaLavoro, pulisciTmp, upload.array('file', 1), auth.verificaCsrf, async (req, res, next) => {
  try {
    const data = dataONull(req.body.data);
    const tipo = testo(req.body.tipo, 120);
    if (!data || !tipo) { flash(req, 'errore', 'Indica data e tipo del verbale.'); return res.redirect(`/studio/lavori/${req.lavoro.id}#sicurezza`); }
    const f = (req.files || [])[0];
    await imprese.salvaVerbale(req.lavoro.id, { data, tipo, note: testo(req.body.note, 2000) || null, visibile: req.body.visibile ? 1 : 0 },
      f && f.path, f && Buffer.from(f.originalname, 'latin1').toString('utf8'));
    flash(req, 'ok', 'Verbale registrato.');
    res.redirect(`/studio/lavori/${req.lavoro.id}#sicurezza`);
  } catch (e) { next(e); }
});

router.get('/lavori/:id/verbali/:vid', trovaLavoro, (req, res) => {
  const abs = imprese.percorsoVerbale(imprese.Q.verbale.get(Number(req.params.vid), req.lavoro.id));
  if (!abs) return res.status(404).render('errore', { titolo: 'File non trovato', messaggio: '' });
  inviaFile(res, abs, { scarica: req.query.scarica === '1' });
});

router.post('/lavori/:id/verbali/:vid', trovaLavoro, auth.verificaCsrf, async (req, res, next) => {
  try {
    const vid = Number(req.params.vid);
    if (req.body.azione === 'elimina') {
      const ok = await imprese.eliminaVerbale(req.lavoro.id, vid);
      flash(req, ok ? 'ok' : 'errore', ok ? 'Verbale eliminato.' : 'Verbale non trovato.');
    } else {
      imprese.Q.visibilitaVerbale.run(req.body.visibile ? 1 : 0, vid, req.lavoro.id);
      flash(req, 'ok', 'Verbale aggiornato.');
    }
    res.redirect(`/studio/lavori/${req.lavoro.id}#sicurezza`);
  } catch (e) { next(e); }
});

// ---------- Documenti richiesti al cliente ----------
router.post('/lavori/:id/richieste', trovaLavoro, auth.verificaCsrf, async (req, res, next) => {
  try {
    const titolo = testo(req.body.titolo, 120);
    if (!titolo) { flash(req, 'errore', 'Indica quale documento chiedi.'); return res.redirect(`/studio/lavori/${req.lavoro.id}#richieste`); }
    const descrizione = testo(req.body.descrizione, 1000);
    richieste.crea(req.lavoro, titolo, descrizione);
    let msg = `Richiesta «${titolo}» aggiunta: il cliente la vede nella sua area.`;
    if (req.body.email) {
      const esito = await avvisaClienti(req, req.lavoro, `Documento richiesto: ${titolo}`,
        `per proseguire con il lavoro «${req.lavoro.titolo}» mi serve questo documento:\n\n${titolo}${descrizione ? '\n' + descrizione : ''}\n\nPuoi caricarlo direttamente dall'area clienti, nella sezione "Documenti richiesti".`);
      msg += esito.inviati ? ` Email inviata a ${esito.inviati} client${esito.inviati === 1 ? 'e' : 'i'}.` : ' Nessuna email inviata (posta non configurata o lavoro non visibile).';
    }
    flash(req, 'ok', msg);
    res.redirect(`/studio/lavori/${req.lavoro.id}#richieste`);
  } catch (e) { next(e); }
});

router.post('/lavori/:id/richieste/:rid', trovaLavoro, auth.verificaCsrf, (req, res) => {
  const r = richieste.Q.perId.get(Number(req.params.rid), req.lavoro.id);
  if (!r) flash(req, 'errore', 'Richiesta non trovata.');
  else if (req.body.azione === 'elimina') {
    richieste.Q.elimina.run(r.id, req.lavoro.id);
    flash(req, 'ok', `Richiesta eliminata. I file già ricevuti restano nella cartella «${richieste.CARTELLA}» del lavoro.`);
  } else if (req.body.azione === 'completa') {
    richieste.Q.stato.run('completa', 'completa', r.id);
    flash(req, 'ok', 'Segnata come ricevuta: il cliente vede la conferma.');
  } else if (req.body.azione === 'riapri') {
    richieste.Q.stato.run('aperta', 'aperta', r.id);
    flash(req, 'ok', 'Richiesta riaperta: il cliente può caricare di nuovo.');
  }
  res.redirect(`/studio/lavori/${req.lavoro.id}#richieste`);
});

router.get('/lavori/:id/richieste/:rid/file/:fid', trovaLavoro, (req, res) => {
  const r = richieste.Q.perId.get(Number(req.params.rid), req.lavoro.id);
  const f = r && richieste.Q.fileId.get(Number(req.params.fid), r.id);
  const abs = f && richieste.percorsoFile(req.lavoro, r, f);
  if (!abs) return res.status(404).render('errore', { titolo: 'File non trovato', messaggio: 'Il file non è più nella cartella del lavoro.' });
  inviaFile(res, abs, { scarica: req.query.scarica === '1' });
});

module.exports = router;
