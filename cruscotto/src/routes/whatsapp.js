'use strict';
/** Chat WhatsApp importate dalla cartella di Drive, collegate ai clienti, con bozza di risposta. */
const express = require('express');
const { verificaCsrf } = require('../sicurezza');
const wa = require('../whatsapp');
const ai = require('../ai');
const F = require('../formato');
const { Clienti, Whatsapp } = require('../modelli');

const router = express.Router();
const testo = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
const flash = (req, tipo, msg) => { req.session.flash = { tipo, msg }; };

function trova(req, res, next) {
  const c = Whatsapp.perId.get(Number(req.params.id));
  if (!c) return res.status(404).render('errore', { titolo: 'Chat non trovata', messaggio: '' });
  req.chat = c;
  next();
}

router.get('/', (req, res) => {
  res.render('whatsapp', { titolo: 'WhatsApp', chat: Whatsapp.tutte.all(), stato: wa.stato(), aiAttiva: ai.attiva() });
});

router.post('/importa', verificaCsrf, async (req, res) => {
  try {
    const r = await wa.importa();
    if (!r.cartella) flash(req, 'errore', 'Non trovo la cartella su Google Drive: controlla che Drive sia avviato sul PC.');
    else if (!r.file && !r.errori.length) flash(req, 'info', 'Nessuna chat nuova nella cartella.');
    else flash(req, r.errori.length ? 'info' : 'ok', `Importate ${r.file} chat (${r.nuovi} messaggi nuovi${r.bozze ? `, ${r.bozze} bozze pronte` : ''}).${r.errori.length ? ` Non lette: ${r.errori.join('; ')}` : ''}`);
  } catch (e) {
    flash(req, 'errore', `Importazione non riuscita: ${e.message}`);
  }
  res.redirect('/whatsapp');
});

router.get('/:id', trova, (req, res) => {
  res.render('whatsapp-chat', {
    titolo: req.chat.cliente_nome || req.chat.nome,
    chat: req.chat,
    messaggi: Whatsapp.messaggi.all(req.chat.id, 300),
    clienti: Clienti.tutti.all(),
    telefono: req.chat.cliente_telefono || (req.chat.telefono ? `+${req.chat.telefono}` : ''),
    aiAttiva: ai.attiva(),
  });
});

router.post('/:id/collega', trova, verificaCsrf, (req, res) => {
  const c = Clienti.perId.get(Number(req.body.cliente_id) || 0);
  Whatsapp.collega.run(c ? c.id : null, req.chat.id);
  flash(req, 'ok', c ? `Chat collegata a ${c.nome}.` : 'Collegamento rimosso.');
  res.redirect(`/whatsapp/${req.chat.id}`);
});

router.post('/:id/bozza', trova, verificaCsrf, async (req, res) => {
  try {
    await wa.preparaBozza(req.chat.id, testo(req.body.istruzioni, 3000));
    flash(req, 'ok', 'Bozza pronta: rileggila prima di inviarla.');
  } catch (e) {
    if (!(e instanceof ai.ErroreAI)) console.error(e);
    flash(req, 'errore', e instanceof ai.ErroreAI ? e.message : 'Errore imprevisto durante la preparazione della bozza.');
  }
  res.redirect(`/whatsapp/${req.chat.id}#risposta`);
});

router.post('/:id/invia', trova, verificaCsrf, (req, res) => {
  const corpo = testo(req.body.testo, 10000);
  Whatsapp.modificaBozza.run(corpo, req.chat.id);
  const link = F.linkWhatsapp(testo(req.body.telefono, 50), corpo);
  if (!corpo || !link) {
    flash(req, 'errore', !corpo ? 'Il testo della risposta è vuoto.' : 'Numero di telefono non valido: aggiungilo nella scheda del cliente.');
    return res.redirect(`/whatsapp/${req.chat.id}#risposta`);
  }
  Whatsapp.cambiaStato.run('gestita', req.chat.id);
  res.redirect(303, link);
});

router.post('/:id/gestita', trova, verificaCsrf, (req, res) => {
  Whatsapp.cambiaStato.run('gestita', req.chat.id);
  const t = String(req.body.torna || '');
  res.redirect(/^\/[\w\-/#?=&]*$/.test(t) && !t.startsWith('//') ? t : '/whatsapp');
});

router.post('/:id/riapri', trova, verificaCsrf, (req, res) => {
  Whatsapp.cambiaStato.run(req.chat.bozza_testo ? 'bozza' : 'da_rispondere', req.chat.id);
  res.redirect(`/whatsapp/${req.chat.id}`);
});

module.exports = router;
