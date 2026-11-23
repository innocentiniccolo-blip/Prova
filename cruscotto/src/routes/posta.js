'use strict';
/** Posta in arrivo: mail lette dalla casella, abbinate alle pratiche, con bozza di risposta da approvare. */
const express = require('express');
const config = require('../config');
const { verificaCsrf } = require('../sicurezza');
const posta = require('../posta');
const sinc = require('../sincronizza');
const ai = require('../ai');
const F = require('../formato');
const { Pratiche, Comunicazioni, Email } = require('../modelli');

const router = express.Router();
const testo = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
const flash = (req, tipo, msg) => { req.session.flash = { tipo, msg }; };

const VISTE = {
  'da-rispondere': { titolo: 'Da rispondere', elenco: () => Email.daRispondere.all() },
  inviate: { titolo: 'Risposte inviate', elenco: () => Email.perStato.all('inviata') },
  archiviate: { titolo: 'Archiviate', elenco: () => Email.perStato.all('archiviata') },
  tutte: { titolo: 'Tutte', elenco: () => Email.tutte.all() },
};

function trova(req, res, next) {
  const e = Email.perId.get(Number(req.params.id));
  if (!e) return res.status(404).render('errore', { titolo: 'Mail non trovata', messaggio: '' });
  req.email = e;
  next();
}

router.get('/', (req, res) => {
  const vista = VISTE[req.query.vista] ? req.query.vista : 'da-rispondere';
  res.render('posta', { titolo: 'Posta', vista, viste: VISTE, email: VISTE[vista].elenco(), stato: sinc.stato(), aiAttiva: ai.attiva(), posta: config.posta });
});

router.post('/controlla', verificaCsrf, async (req, res) => {
  try {
    const r = await sinc.controlla();
    flash(req, 'ok', r.nuove ? `${r.nuove} mail nuove${r.bozze ? `, ${r.bozze} bozze di risposta pronte` : ''}.` : 'Nessuna mail nuova.');
  } catch (e) {
    flash(req, 'errore', e.message);
  }
  res.redirect('/posta');
});

router.get('/:id', trova, (req, res) => {
  const e = req.email;
  const pratiche = Pratiche.tutte.all();
  // Prima le pratiche del cliente mittente, poi le altre aperte
  const chiusi = config.studio.pratiche.statiChiusi;
  const ordinate = [
    ...pratiche.filter((p) => e.cliente_id && p.cliente_id === e.cliente_id),
    ...pratiche.filter((p) => !(e.cliente_id && p.cliente_id === e.cliente_id) && (!chiusi.includes(p.stato) || p.id === e.pratica_id)),
  ];
  res.render('email', {
    titolo: e.oggetto || '(senza oggetto)',
    email: e,
    pratiche: ordinate,
    destinatario: e.rispondi_a || e.mittente_email || '',
    oggettoRisposta: e.bozza_oggetto || (/^re:/i.test(e.oggetto || '') ? e.oggetto : `Re: ${e.oggetto || ''}`),
    aiAttiva: ai.attiva(),
    indirizzoStudio: config.posta.indirizzo,
  });
});

router.post('/:id/abbina', trova, verificaCsrf, (req, res) => {
  const pid = Number(req.body.pratica_id) || null;
  const p = pid ? Pratiche.perId.get(pid) : null;
  Email.abbina.run(p ? p.id : null, req.email.id);
  flash(req, 'ok', p ? `Mail collegata alla pratica ${p.tipo}${p.cliente_nome ? ' – ' + p.cliente_nome : ''}.` : 'Collegamento alla pratica rimosso.');
  res.redirect(`/posta/${req.email.id}`);
});

router.post('/:id/bozza', trova, verificaCsrf, async (req, res) => {
  try {
    await sinc.preparaBozza(req.email.id, testo(req.body.istruzioni, 3000));
    flash(req, 'ok', 'Bozza pronta: rileggila e completa i punti tra [parentesi quadre].');
  } catch (e) {
    if (!(e instanceof ai.ErroreAI)) console.error(e);
    flash(req, 'errore', e instanceof ai.ErroreAI ? e.message : 'Errore imprevisto durante la preparazione della bozza.');
  }
  res.redirect(`/posta/${req.email.id}#risposta`);
});

function datiRisposta(req) {
  return { a: testo(req.body.a, 200), oggetto: testo(req.body.oggetto, 300), testo: testo(req.body.testo, 50000) };
}

router.post('/:id/risposta', trova, verificaCsrf, async (req, res) => {
  const e = req.email;
  const d = datiRisposta(req);
  const azione = req.body.azione;
  Email.modificaBozza.run(d.oggetto, d.testo, e.id); // il testo corretto non va mai perso

  if (azione === 'salva') {
    flash(req, 'ok', 'Bozza salvata.');
    return res.redirect(`/posta/${e.id}#risposta`);
  }
  if (!F.emailValida(d.a)) { flash(req, 'errore', 'Indirizzo del destinatario non valido.'); return res.redirect(`/posta/${e.id}#risposta`); }
  if (!d.testo) { flash(req, 'errore', 'Il testo della risposta è vuoto.'); return res.redirect(`/posta/${e.id}#risposta`); }

  const messaggio = { ...d, inReplyTo: e.message_id, riferimenti: e.riferimenti };
  try {
    if (azione === 'thunderbird') {
      await posta.salvaBozza(messaggio);
      Email.cambiaStato.run('archiviata', 'archiviata', e.id);
      flash(req, 'ok', 'Risposta salvata nella cartella Bozze: la trovi in Thunderbird, pronta da spedire.');
    } else {
      const r = await posta.invia(messaggio, { uidvalidity: e.uidvalidity, uid: e.uid });
      Email.cambiaStato.run('inviata', 'inviata', e.id);
      if (e.pratica_id) {
        Comunicazioni.inserisci.run(e.pratica_id, 'email', d.a, d.oggetto, d.testo);
        Pratiche.tocca.run(e.pratica_id);
      }
      flash(req, r.copia ? 'ok' : 'info', r.copia ? `Risposta inviata a ${d.a}. La copia è nella cartella Inviata.`
        : `Risposta inviata a ${d.a}, ma non sono riuscito a salvarne la copia in "Inviata"${r.avviso ? ` (${r.avviso})` : ''}.`);
    }
    return res.redirect('/posta');
  } catch (err) {
    flash(req, 'errore', err instanceof posta.ErrorePosta ? err.message : `Errore: ${err.message}`);
    if (!(err instanceof posta.ErrorePosta)) console.error(err);
    return res.redirect(`/posta/${e.id}#risposta`);
  }
});

router.post('/:id/archivia', trova, verificaCsrf, (req, res) => {
  Email.cambiaStato.run('archiviata', 'archiviata', req.email.id);
  flash(req, 'ok', 'Mail archiviata.');
  torna(req, res);
});

router.post('/:id/riapri', trova, verificaCsrf, (req, res) => {
  Email.cambiaStato.run(req.email.bozza_testo ? 'bozza' : 'nuova', 'nuova', req.email.id);
  res.redirect(`/posta/${req.email.id}`);
});

function torna(req, res) {
  const t = String(req.body.torna || '');
  res.redirect(/^\/[\w\-/#?=&]*$/.test(t) && !t.startsWith('//') ? t : '/posta');
}

module.exports = router;
