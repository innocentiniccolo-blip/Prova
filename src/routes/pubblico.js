'use strict';
const express = require('express');
const config = require('../config');
const { Utenti } = require('../modelli');
const auth = require('../auth');

const router = express.Router();

router.get('/', (req, res) => {
  if (config.soloArea) return res.redirect(req.utente ? '/area' : '/accedi');
  res.render('home', { titolo: null });
});

router.get('/accedi', (req, res) => {
  if (req.utente) return res.redirect(req.utente.ruolo === 'admin' ? '/studio' : '/area');
  res.render('accedi', { titolo: 'Area clienti', errore: null, email: '' });
});

router.post('/accedi', auth.verificaCsrf, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    const errore = (msg) => res.status(401).render('accedi', { titolo: 'Area clienti', errore: msg, email });

    if (auth.loginBloccato(req, email)) return errore('Troppi tentativi. Riprova tra 15 minuti.');
    const u = email ? Utenti.perEmail.get(email) : null;
    const ok = u && u.attivo && (await auth.verificaPassword(password, u.password_hash));
    if (!ok) {
      auth.registraErrore(req, email);
      return errore('Email o password non corretti.');
    }
    auth.azzeraTentativi(req, email);
    const dopo = req.session.dopoLogin;
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.utenteId = u.id;
      Utenti.segnaAccesso.run(u.id);
      const home = u.ruolo === 'admin' ? '/studio' : '/area';
      const sicuro = typeof dopo === 'string' && dopo.startsWith('/') && !dopo.startsWith('//');
      res.redirect(sicuro ? dopo : home);
    });
  } catch (e) { next(e); }
});

router.post('/esci', auth.verificaCsrf, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('studio.sid');
    res.redirect('/');
  });
});

module.exports = router;
