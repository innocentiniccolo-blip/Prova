'use strict';
/** Cruscotto e gestione delle pratiche: scadenze, attività, incassi, comunicazioni. */
const express = require('express');
const config = require('../config');
const { verificaCsrf } = require('../sicurezza');
const ai = require('../ai');
const F = require('../formato');
const cartelle = require('../cartelle');
const { Clienti, Pratiche, Scadenze, Attivita, Incassi, Comunicazioni, Email, Whatsapp } = require('../modelli');

const router = express.Router();
const P = config.studio.pratiche;

const testo = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
const dataONull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);
const flash = (req, tipo, msg) => { req.session.flash = { tipo, msg }; };
const aperta = (p) => !P.statiChiusi.includes(p.stato);
const residuo = (p) => Math.max((p.onorario_cent || 0) - (p.incassato_cent || 0), 0);

/** Torna alla pagina indicata nel modulo (solo percorsi interni). */
function torna(req, res, predefinito) {
  const t = String(req.body.torna || '');
  res.redirect(/^\/([\w\-/#?=&]*)$/.test(t) && !t.startsWith('//') ? t : predefinito);
}

function trovaPratica(req, res, next) {
  const pratica = Pratiche.perId.get(Number(req.params.id));
  if (!pratica) return res.status(404).render('errore', { titolo: 'Pratica non trovata', messaggio: '' });
  req.pratica = pratica;
  next();
}

// ---------- Cruscotto ----------
router.get('/', (req, res) => {
  const pratiche = Pratiche.tutte.all();
  const aperte = pratiche.filter(aperta);
  const oggi = F.oggi();
  const scadenze = Scadenze.aperteFinoA.all(F.piuGiorni(oggi, 30));
  const scadute = scadenze.filter((s) => s.data < oggi);
  const entro15 = scadenze.filter((s) => s.data >= oggi && s.data <= F.piuGiorni(oggi, 15));
  const daIncassare = pratiche.filter((p) => p.stato !== 'Archiviata').reduce((t, p) => t + residuo(p), 0);
  aperte.sort((a, b) => (a.prossima_scadenza || '9999').localeCompare(b.prossima_scadenza || '9999'));
  res.render('cruscotto', {
    titolo: 'Cruscotto',
    aperte, scadenze, nScadute: scadute.length, nEntro15: entro15.length,
    attivita: Attivita.aperte.all(),
    daIncassare,
    incassatoAnno: Incassi.totaleAnno.get(oggi.slice(0, 4)).tot,
    anno: oggi.slice(0, 4),
    mailDaRispondere: config.posta.attiva ? Email.daRispondere.all() : null,
    waDaRispondere: Whatsapp.daRispondere.all(),
  });
});

router.get('/pratiche', (req, res) => {
  const pratiche = Pratiche.tutte.all();
  res.render('pratiche', { titolo: 'Pratiche', pratiche });
});

// ---------- Scheda pratica ----------
function datiPratica(body) {
  return {
    cliente_id: Number(body.cliente_id) || null,
    commessa: testo(body.commessa, 40),
    indirizzo: testo(body.indirizzo, 300),
    cartella: cartelle.normalizza(body.cartella),
    tipo: testo(body.tipo, 120),
    ente: testo(body.ente, 200),
    oggetto: testo(body.oggetto, 2000),
    stato: P.stati.includes(body.stato) ? body.stato : P.stati[0],
    protocollo: testo(body.protocollo, 80),
    data_protocollo: dataONull(body.data_protocollo),
    numero_pratica: testo(body.numero_pratica, 80),
    onorario_cent: Math.max(F.euroInCentesimi(body.onorario) || 0, 0),
    note: testo(body.note, 5000),
  };
}

async function renderForm(res, pratica, errore) {
  res.status(errore ? 400 : 200).render('pratica-form', {
    titolo: pratica.id ? `Modifica pratica ${pratica.tipo || ''}` : 'Nuova pratica',
    pratica, errore, clienti: Clienti.tutti.all(),
    driveAttivo: cartelle.ricarica() !== null, cartelleStudio: await cartelle.cartelleStudio(),
  });
}

/** Crea su Drive la cartella della pratica, se richiesto e se non esiste già. Ritorna un messaggio per l'utente. */
async function preparaCartella(body, dati) {
  if (!dati.cartella || !body.crea_cartella || !cartelle.attiva() || cartelle.esiste(dati.cartella)) return '';
  try {
    await cartelle.crea(dati.cartella, true);
    return ` Cartella "${dati.cartella}" creata su Google Drive con le sottocartelle standard.`;
  } catch (e) {
    return ` Attenzione: non sono riuscito a creare la cartella su Drive (${e.message}).`;
  }
}

/** Se nel modulo è stato scritto un cliente nuovo, lo crea e lo collega alla pratica. */
function clienteNuovo(body, dati) {
  const nome = testo(body.nuovo_cliente_nome, 200);
  if (dati.cliente_id || !nome) return;
  const { lastInsertRowid } = Clienti.inserisci.run({
    nome, telefono: testo(body.nuovo_cliente_telefono, 50), email: testo(body.nuovo_cliente_email, 200).toLowerCase(), note: '',
  });
  dati.cliente_id = Number(lastInsertRowid);
}

function validaPratica(dati) {
  if (dati.cliente_id && !Clienti.perId.get(dati.cliente_id)) return 'Cliente non trovato.';
  if (!dati.tipo) return 'Il tipo di pratica è obbligatorio.';
  if (dati.cartella === null && dati._cartellaScritta) return 'Nome della cartella non valido (non usare i caratteri < > : " | ? *).';
  return null;
}

router.get('/pratiche/nuova', async (req, res) => {
  const cliente = Clienti.perId.get(Number(req.query.cliente) || 0);
  await renderForm(res, { cliente_id: cliente?.id || '', cartella: cliente?.nome || '', stato: P.stati[0], onorario: '' }, null);
});

function datiDaModulo(body) {
  const dati = datiPratica(body);
  Object.defineProperty(dati, '_cartellaScritta', { value: Boolean(testo(body.cartella)), enumerable: false });
  return dati;
}

router.post('/pratiche', verificaCsrf, async (req, res) => {
  const dati = datiDaModulo(req.body);
  const errore = validaPratica(dati);
  if (errore) return renderForm(res, { ...req.body }, errore);
  clienteNuovo(req.body, dati);
  const msgCartella = await preparaCartella(req.body, dati);
  const { lastInsertRowid } = Pratiche.inserisci.run(dati);
  flash(req, msgCartella.includes('Attenzione') ? 'info' : 'ok', `Pratica creata.${msgCartella}`);
  res.redirect(`/pratiche/${lastInsertRowid}`);
});

router.get('/pratiche/:id', trovaPratica, async (req, res) => {
  const p = req.pratica;
  cartelle.ricarica();
  const cartellaOk = Boolean(p.cartella && cartelle.esiste(p.cartella));
  res.render('pratica', {
    drive: { attivo: cartelle.attiva(), radice: cartelle.radice(), cartellaOk, ...(cartellaOk ? await cartelle.contenuto(p.cartella) : { voci: [] }) },
    titolo: `${p.tipo}${p.cliente_nome ? ' – ' + p.cliente_nome : ''}`,
    pratica: p,
    residuo: residuo(p),
    scadenze: Scadenze.perPratica.all(p.id),
    attivita: Attivita.perPratica.all(p.id),
    incassi: Incassi.perPratica.all(p.id),
    comunicazioni: Comunicazioni.perPratica.all(p.id),
    emailRicevute: Email.perPratica.all(p.id),
    contatti: p.cliente_id ? [{ id: p.cliente_id, nome: p.cliente_nome, email: p.cliente_email, telefono: p.cliente_telefono }] : [],
    aiAttiva: ai.attiva(),
    oggi: F.oggi(),
  });
});

router.get('/pratiche/:id/modifica', trovaPratica, async (req, res) => {
  await renderForm(res, { ...req.pratica, onorario: F.centesimiInTesto(req.pratica.onorario_cent) }, null);
});

router.post('/pratiche/:id', trovaPratica, verificaCsrf, async (req, res) => {
  const dati = datiDaModulo(req.body);
  dati.id = req.pratica.id;
  const errore = validaPratica(dati);
  if (errore) return renderForm(res, { ...req.body, id: req.pratica.id }, errore);
  clienteNuovo(req.body, dati);
  const msgCartella = await preparaCartella(req.body, dati);
  Pratiche.aggiorna.run(dati);
  flash(req, msgCartella.includes('Attenzione') ? 'info' : 'ok', `Pratica aggiornata.${msgCartella}`);
  res.redirect(`/pratiche/${req.pratica.id}`);
});

router.post('/pratiche/:id/stato', trovaPratica, verificaCsrf, (req, res) => {
  if (P.stati.includes(req.body.stato)) {
    Pratiche.cambiaStato.run(req.body.stato, req.pratica.id);
    flash(req, 'ok', `Stato aggiornato: ${req.body.stato}.`);
  }
  res.redirect(`/pratiche/${req.pratica.id}`);
});

router.post('/pratiche/:id/elimina', trovaPratica, verificaCsrf, (req, res) => {
  Pratiche.elimina.run(req.pratica.id);
  flash(req, 'ok', `Pratica ${req.pratica.tipo} eliminata.`);
  res.redirect(req.pratica.cliente_id ? `/clienti/${req.pratica.cliente_id}` : '/pratiche');
});

// ---------- Scadenze ----------
router.post('/pratiche/:id/scadenze', trovaPratica, verificaCsrf, (req, res) => {
  const descr = testo(req.body.descrizione, 300);
  const data = dataONull(req.body.data);
  if (descr && data) {
    Scadenze.inserisci.run(req.pratica.id, descr, data);
    Pratiche.tocca.run(req.pratica.id);
  } else flash(req, 'errore', 'Indica descrizione e data della scadenza.');
  res.redirect(`/pratiche/${req.pratica.id}#scadenze`);
});

router.post('/pratiche/:id/scadenze/:sid/segna', trovaPratica, verificaCsrf, (req, res) => {
  Scadenze.segna.run({ fatta: req.body.fatta === '1' ? 1 : 0, id: Number(req.params.sid), pratica_id: req.pratica.id });
  torna(req, res, `/pratiche/${req.pratica.id}#scadenze`);
});

router.post('/pratiche/:id/scadenze/:sid/elimina', trovaPratica, verificaCsrf, (req, res) => {
  Scadenze.elimina.run(Number(req.params.sid), req.pratica.id);
  res.redirect(`/pratiche/${req.pratica.id}#scadenze`);
});

// ---------- Attività ----------
router.post('/pratiche/:id/attivita', trovaPratica, verificaCsrf, (req, res) => {
  const t = testo(req.body.testo, 500);
  if (t) {
    Attivita.inserisci.run(req.pratica.id, t);
    Pratiche.tocca.run(req.pratica.id);
  }
  res.redirect(`/pratiche/${req.pratica.id}#attivita`);
});

router.post('/pratiche/:id/attivita/:aid/segna', trovaPratica, verificaCsrf, (req, res) => {
  Attivita.segna.run({ fatta: req.body.fatta === '1' ? 1 : 0, id: Number(req.params.aid), pratica_id: req.pratica.id });
  torna(req, res, `/pratiche/${req.pratica.id}#attivita`);
});

router.post('/pratiche/:id/attivita/:aid/elimina', trovaPratica, verificaCsrf, (req, res) => {
  Attivita.elimina.run(Number(req.params.aid), req.pratica.id);
  res.redirect(`/pratiche/${req.pratica.id}#attivita`);
});

// ---------- Incassi ----------
router.post('/pratiche/:id/incassi', trovaPratica, verificaCsrf, (req, res) => {
  const cent = F.euroInCentesimi(req.body.importo);
  const data = dataONull(req.body.data) || F.oggi();
  if (cent && cent > 0) {
    Incassi.inserisci.run(req.pratica.id, data, cent, testo(req.body.descrizione, 200));
    Pratiche.tocca.run(req.pratica.id);
    flash(req, 'ok', `Registrato incasso di ${F.euro(cent)}.`);
  } else flash(req, 'errore', 'Importo non valido (es. 500 oppure 1.250,00).');
  res.redirect(`/pratiche/${req.pratica.id}#incassi`);
});

router.post('/pratiche/:id/incassi/:iid/elimina', trovaPratica, verificaCsrf, (req, res) => {
  Incassi.elimina.run(Number(req.params.iid), req.pratica.id);
  res.redirect(`/pratiche/${req.pratica.id}#incassi`);
});

// ---------- Comunicazioni (email / WhatsApp con bozza AI) ----------
router.post('/pratiche/:id/genera-messaggio', express.json({ limit: '50kb' }), trovaPratica, verificaCsrf, async (req, res) => {
  const canale = req.body.canale === 'whatsapp' ? 'whatsapp' : 'email';
  try {
    const bozza = await ai.generaMessaggio({
      pratica: req.pratica,
      scadenze: Scadenze.perPratica.all(req.pratica.id),
      attivita: Attivita.perPratica.all(req.pratica.id),
      destinatario: testo(req.body.destinatario_nome, 200),
      canale,
      istruzioni: testo(req.body.istruzioni, 3000),
    });
    res.json(bozza);
  } catch (e) {
    if (e instanceof ai.ErroreAI) return res.status(503).json({ errore: e.message });
    console.error(e);
    res.status(500).json({ errore: 'Errore imprevisto durante la generazione.' });
  }
});

router.post('/pratiche/:id/comunicazioni', trovaPratica, verificaCsrf, (req, res) => {
  const canale = req.body.canale === 'whatsapp' ? 'whatsapp' : 'email';
  const corpo = testo(req.body.testo, 10000);
  const oggetto = canale === 'email' ? testo(req.body.oggetto, 300) : '';
  const destinatario = canale === 'email' ? testo(req.body.email, 200) : testo(req.body.telefono, 50);
  const link = canale === 'email' ? F.linkEmail(destinatario, oggetto, corpo) : F.linkWhatsapp(destinatario, corpo);
  const errore = !corpo ? 'Scrivi (o genera) il testo del messaggio.'
    : !link ? (canale === 'email' ? 'Indirizzo email del destinatario non valido.' : 'Numero di telefono non valido per WhatsApp.')
      : null;
  if (errore) {
    flash(req, 'errore', errore);
    return res.redirect(`/pratiche/${req.pratica.id}#comunicazioni`);
  }
  const nome = testo(req.body.destinatario_nome, 200);
  Comunicazioni.inserisci.run(req.pratica.id, canale, nome ? `${nome} <${destinatario}>` : destinatario, oggetto, corpo);
  Pratiche.tocca.run(req.pratica.id);
  // Apre WhatsApp o il programma di posta con il messaggio già compilato
  res.redirect(303, link);
});

router.post('/pratiche/:id/comunicazioni/:cid/elimina', trovaPratica, verificaCsrf, (req, res) => {
  Comunicazioni.elimina.run(Number(req.params.cid), req.pratica.id);
  res.redirect(`/pratiche/${req.pratica.id}#comunicazioni`);
});

// ---------- Cartella su Google Drive ----------
const multer = require('multer');
const tmpUpload = require('node:path').join(config.datiDir, 'tmp');
require('node:fs').mkdirSync(tmpUpload, { recursive: true });
const upload = multer({ dest: tmpUpload, limits: { fileSize: 500 * 1024 * 1024, files: 50 } });

/** Percorso dentro la cartella della pratica (es. "006-Pratiche/tavola.pdf"), controllato. */
function dentroPratica(pratica, sotto) {
  if (!pratica.cartella) return null;
  const s = sotto ? cartelle.normalizza(sotto) : '';
  if (sotto && !s) return null;
  return s ? `${pratica.cartella}/${s}` : pratica.cartella;
}

router.post('/pratiche/:id/cartella/apri', trovaPratica, verificaCsrf, (req, res) => {
  const rel = dentroPratica(req.pratica, testo(req.body.percorso, 1000));
  if (!rel || !cartelle.apri(rel)) flash(req, 'errore', 'Non riesco ad aprire: controlla che Google Drive sia avviato sul PC.');
  res.redirect(`/pratiche/${req.pratica.id}#cartella`);
});

router.post('/pratiche/:id/cartella/crea', trovaPratica, verificaCsrf, async (req, res) => {
  try {
    if (!req.pratica.cartella) throw new Error('indica prima il nome della cartella nella pratica');
    await cartelle.crea(req.pratica.cartella, true);
    flash(req, 'ok', `Cartella "${req.pratica.cartella}" creata su Google Drive.`);
  } catch (e) {
    flash(req, 'errore', `Cartella non creata: ${e.message}`);
  }
  res.redirect(`/pratiche/${req.pratica.id}#cartella`);
});

function pulisciTmp(req, res, next) {
  res.on('close', () => { for (const f of req.files || []) require('node:fs').rm(f.path, { force: true }, () => {}); });
  next();
}

router.post('/pratiche/:id/cartella/carica', trovaPratica, pulisciTmp, upload.array('file'), verificaCsrf, async (req, res, next) => {
  try {
    const rel = dentroPratica(req.pratica, testo(req.body.sottocartella, 500));
    if (!rel || !cartelle.esiste(req.pratica.cartella)) throw new Error('Cartella della pratica non trovata.');
    const nomi = [];
    // multer legge i nomi come latin1: li riconverto in UTF-8 (accenti)
    for (const f of req.files || []) nomi.push(await cartelle.salva(rel, f.path, Buffer.from(f.originalname, 'latin1').toString('utf8')));
    if (nomi.length) Pratiche.tocca.run(req.pratica.id);
    flash(req, 'ok', nomi.length ? `Caricati su Drive: ${nomi.join(', ')}` : 'Nessun file scelto.');
    res.redirect(`/pratiche/${req.pratica.id}#cartella`);
  } catch (e) {
    if (e.message.includes('non trovata') || e.message.includes('non valida')) {
      flash(req, 'errore', e.message);
      return res.redirect(`/pratiche/${req.pratica.id}#cartella`);
    }
    next(e);
  }
});

module.exports = router;
