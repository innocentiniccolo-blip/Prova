'use strict';
/** Cruscotto e gestione delle pratiche (solo studio): scadenze, attività, incassi, comunicazioni. */
const express = require('express');
const config = require('../config');
const auth = require('../auth');
const ai = require('../ai');
const F = require('../formato');
const { db, Lavori, Pratiche, Scadenze, Attivita, Incassi, Comunicazioni } = require('../modelli');

const router = express.Router();
const P = config.studio.pratiche;

const testo = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
const dataONull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);
const flash = (req, tipo, msg) => { req.session.flash = { tipo, msg }; };
const aperta = (p) => !P.statiChiusi.includes(p.stato);
const residuo = (p) => Math.max((p.onorario_cent || 0) - (p.incassato_cent || 0), 0);

/** Torna alla pagina indicata nel modulo (solo percorsi interni del pannello). */
function torna(req, res, predefinito) {
  const t = String(req.body.torna || '');
  res.redirect(/^\/studio([/#?][\w\-/#?=&]*)?$/.test(t) ? t : predefinito);
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
  res.render('admin/cruscotto', {
    titolo: 'Cruscotto',
    aperte, scadenze, nScadute: scadute.length, nEntro15: entro15.length,
    attivita: Attivita.aperte.all(),
    daIncassare,
    incassatoAnno: Incassi.totaleAnno.get(oggi.slice(0, 4)).tot,
    anno: oggi.slice(0, 4),
    nLavori: Lavori.elenco.all().length,
  });
});

router.get('/pratiche', (req, res) => {
  const pratiche = Pratiche.tutte.all();
  res.render('admin/pratiche', { titolo: 'Pratiche', pratiche });
});

// ---------- Scheda pratica ----------
function datiPratica(body) {
  return {
    lavoro_id: Number(body.lavoro_id) || 0,
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

function renderForm(res, pratica, errore) {
  res.status(errore ? 400 : 200).render('admin/pratica-form', {
    titolo: pratica.id ? `Modifica pratica ${pratica.tipo || ''}` : 'Nuova pratica',
    pratica, errore, lavori: Lavori.elenco.all(),
  });
}

function validaPratica(dati) {
  if (!Lavori.perId.get(dati.lavoro_id)) return 'Scegli il lavoro a cui appartiene la pratica.';
  if (!dati.tipo) return 'Il tipo di pratica è obbligatorio.';
  return null;
}

router.get('/pratiche/nuova', (req, res) => {
  renderForm(res, { lavoro_id: Number(req.query.lavoro) || '', stato: P.stati[0], onorario: '' }, null);
});

router.post('/pratiche', auth.verificaCsrf, (req, res) => {
  const dati = datiPratica(req.body);
  const errore = validaPratica(dati);
  if (errore) return renderForm(res, { ...req.body }, errore);
  const { lastInsertRowid } = Pratiche.inserisci.run(dati);
  Lavori.tocca.run(dati.lavoro_id);
  flash(req, 'ok', 'Pratica creata.');
  res.redirect(`/studio/pratiche/${lastInsertRowid}`);
});

router.get('/pratiche/:id', trovaPratica, (req, res) => {
  const p = req.pratica;
  res.render('admin/pratica', {
    titolo: `${p.tipo} – ${p.lavoro_codice}`,
    pratica: p,
    residuo: residuo(p),
    scadenze: Scadenze.perPratica.all(p.id),
    attivita: Attivita.perPratica.all(p.id),
    incassi: Incassi.perPratica.all(p.id),
    comunicazioni: Comunicazioni.perPratica.all(p.id),
    contatti: Lavori.clienti.all(p.lavoro_id),
    aiAttiva: ai.attiva(),
    oggi: F.oggi(),
  });
});

router.get('/pratiche/:id/modifica', trovaPratica, (req, res) => {
  renderForm(res, { ...req.pratica, onorario: F.centesimiInTesto(req.pratica.onorario_cent) }, null);
});

router.post('/pratiche/:id', trovaPratica, auth.verificaCsrf, (req, res) => {
  const dati = { ...datiPratica(req.body), id: req.pratica.id };
  const errore = validaPratica(dati);
  if (errore) return renderForm(res, { ...req.body, id: req.pratica.id }, errore);
  Pratiche.aggiorna.run(dati);
  Lavori.tocca.run(dati.lavoro_id);
  flash(req, 'ok', 'Pratica aggiornata.');
  res.redirect(`/studio/pratiche/${req.pratica.id}`);
});

router.post('/pratiche/:id/stato', trovaPratica, auth.verificaCsrf, (req, res) => {
  if (P.stati.includes(req.body.stato)) {
    db.prepare("UPDATE pratiche SET stato = ?, aggiornato_il = datetime('now') WHERE id = ?").run(req.body.stato, req.pratica.id);
    flash(req, 'ok', `Stato aggiornato: ${req.body.stato}.`);
  }
  res.redirect(`/studio/pratiche/${req.pratica.id}`);
});

router.post('/pratiche/:id/elimina', trovaPratica, auth.verificaCsrf, (req, res) => {
  Pratiche.elimina.run(req.pratica.id);
  flash(req, 'ok', `Pratica ${req.pratica.tipo} eliminata.`);
  res.redirect(`/studio/lavori/${req.pratica.lavoro_id}#pratiche`);
});

// ---------- Scadenze ----------
router.post('/pratiche/:id/scadenze', trovaPratica, auth.verificaCsrf, (req, res) => {
  const descr = testo(req.body.descrizione, 300);
  const data = dataONull(req.body.data);
  if (descr && data) {
    Scadenze.inserisci.run(req.pratica.id, descr, data);
    Pratiche.tocca.run(req.pratica.id);
  } else flash(req, 'errore', 'Indica descrizione e data della scadenza.');
  res.redirect(`/studio/pratiche/${req.pratica.id}#scadenze`);
});

router.post('/pratiche/:id/scadenze/:sid/segna', trovaPratica, auth.verificaCsrf, (req, res) => {
  Scadenze.segna.run({ fatta: req.body.fatta === '1' ? 1 : 0, id: Number(req.params.sid), pratica_id: req.pratica.id });
  torna(req, res, `/studio/pratiche/${req.pratica.id}#scadenze`);
});

router.post('/pratiche/:id/scadenze/:sid/elimina', trovaPratica, auth.verificaCsrf, (req, res) => {
  Scadenze.elimina.run(Number(req.params.sid), req.pratica.id);
  res.redirect(`/studio/pratiche/${req.pratica.id}#scadenze`);
});

// ---------- Attività ----------
router.post('/pratiche/:id/attivita', trovaPratica, auth.verificaCsrf, (req, res) => {
  const t = testo(req.body.testo, 500);
  if (t) {
    Attivita.inserisci.run(req.pratica.id, t);
    Pratiche.tocca.run(req.pratica.id);
  }
  res.redirect(`/studio/pratiche/${req.pratica.id}#attivita`);
});

router.post('/pratiche/:id/attivita/:aid/segna', trovaPratica, auth.verificaCsrf, (req, res) => {
  Attivita.segna.run({ fatta: req.body.fatta === '1' ? 1 : 0, id: Number(req.params.aid), pratica_id: req.pratica.id });
  torna(req, res, `/studio/pratiche/${req.pratica.id}#attivita`);
});

router.post('/pratiche/:id/attivita/:aid/elimina', trovaPratica, auth.verificaCsrf, (req, res) => {
  Attivita.elimina.run(Number(req.params.aid), req.pratica.id);
  res.redirect(`/studio/pratiche/${req.pratica.id}#attivita`);
});

// ---------- Incassi ----------
router.post('/pratiche/:id/incassi', trovaPratica, auth.verificaCsrf, (req, res) => {
  const cent = F.euroInCentesimi(req.body.importo);
  const data = dataONull(req.body.data) || F.oggi();
  if (cent && cent > 0) {
    Incassi.inserisci.run(req.pratica.id, data, cent, testo(req.body.descrizione, 200));
    Pratiche.tocca.run(req.pratica.id);
    flash(req, 'ok', `Registrato incasso di ${F.euro(cent)}.`);
  } else flash(req, 'errore', 'Importo non valido (es. 500 oppure 1.250,00).');
  res.redirect(`/studio/pratiche/${req.pratica.id}#incassi`);
});

router.post('/pratiche/:id/incassi/:iid/elimina', trovaPratica, auth.verificaCsrf, (req, res) => {
  Incassi.elimina.run(Number(req.params.iid), req.pratica.id);
  res.redirect(`/studio/pratiche/${req.pratica.id}#incassi`);
});

// ---------- Comunicazioni (email / WhatsApp con bozza AI) ----------
router.post('/pratiche/:id/genera-messaggio', express.json({ limit: '50kb' }), trovaPratica, auth.verificaCsrf, async (req, res) => {
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

router.post('/pratiche/:id/comunicazioni', trovaPratica, auth.verificaCsrf, (req, res) => {
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
    return res.redirect(`/studio/pratiche/${req.pratica.id}#comunicazioni`);
  }
  const nome = testo(req.body.destinatario_nome, 200);
  Comunicazioni.inserisci.run(req.pratica.id, canale, nome ? `${nome} <${destinatario}>` : destinatario, oggetto, corpo);
  Pratiche.tocca.run(req.pratica.id);
  // Apre WhatsApp o il programma di posta con il messaggio già compilato
  res.redirect(303, link);
});

router.post('/pratiche/:id/comunicazioni/:cid/elimina', trovaPratica, auth.verificaCsrf, (req, res) => {
  Comunicazioni.elimina.run(Number(req.params.cid), req.pratica.id);
  res.redirect(`/studio/pratiche/${req.pratica.id}#comunicazioni`);
});

module.exports = router;
