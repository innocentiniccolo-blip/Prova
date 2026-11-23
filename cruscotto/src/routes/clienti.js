'use strict';
/** Rubrica clienti del cruscotto (indipendente dall'area clienti online). */
const express = require('express');
const { verificaCsrf } = require('../sicurezza');
const F = require('../formato');
const { Clienti, Pratiche, Whatsapp } = require('../modelli');

const router = express.Router();
const testo = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
const flash = (req, tipo, msg) => { req.session.flash = { tipo, msg }; };

function dati(body) {
  return { nome: testo(body.nome, 200), telefono: testo(body.telefono, 50), email: testo(body.email, 200).toLowerCase(), note: testo(body.note, 5000) };
}
function errore(c) {
  if (!c.nome) return 'Il nome è obbligatorio.';
  if (c.email && !F.emailValida(c.email)) return 'Email non valida.';
  return null;
}
function trova(req, res, next) {
  const c = Clienti.perId.get(Number(req.params.id));
  if (!c) return res.status(404).render('errore', { titolo: 'Cliente non trovato', messaggio: '' });
  req.cliente = c;
  next();
}

router.get('/', (req, res) => res.render('clienti', { titolo: 'Clienti', clienti: Clienti.tutti.all() }));

router.get('/nuovo', (req, res) => res.render('cliente-form', { titolo: 'Nuovo cliente', cliente: {}, errore: null, pratiche: [] }));

router.post('/', verificaCsrf, (req, res) => {
  const c = dati(req.body);
  const e = errore(c);
  if (e) return res.status(400).render('cliente-form', { titolo: 'Nuovo cliente', cliente: c, errore: e, pratiche: [] });
  const { lastInsertRowid } = Clienti.inserisci.run(c);
  flash(req, 'ok', 'Cliente creato.');
  res.redirect(`/clienti/${lastInsertRowid}`);
});

router.get('/:id', trova, (req, res) => {
  res.render('cliente-form', { titolo: req.cliente.nome, cliente: req.cliente, errore: null, pratiche: Pratiche.perCliente.all(req.cliente.id), chatWa: Whatsapp.perCliente.all(req.cliente.id) });
});

router.post('/:id', trova, verificaCsrf, (req, res) => {
  const c = { ...dati(req.body), id: req.cliente.id };
  const e = errore(c);
  if (e) return res.status(400).render('cliente-form', { titolo: req.cliente.nome, cliente: c, errore: e, pratiche: Pratiche.perCliente.all(c.id) });
  Clienti.aggiorna.run(c);
  flash(req, 'ok', 'Cliente aggiornato.');
  res.redirect(`/clienti/${c.id}`);
});

router.post('/:id/elimina', trova, verificaCsrf, (req, res) => {
  Clienti.elimina.run(req.cliente.id);
  flash(req, 'ok', `Cliente ${req.cliente.nome} eliminato. Le sue pratiche restano, senza cliente.`);
  res.redirect('/clienti');
});

module.exports = router;
