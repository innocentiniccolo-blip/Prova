'use strict';
const crypto = require('node:crypto');
const express = require('express');
const config = require('../config');
const { Utenti } = require('../modelli');
const auth = require('../auth');
const notifiche = require('../notifiche');
const posta = require('../posta');
const linkPassword = require('../link-password');

const router = express.Router();

// ---------- Primo avvio: creazione dell'account dello studio dal browser ----------
// Attiva solo finché non esiste nessun account studio. Serve un codice monouso che
// l'app scrive nel registro (log) del container all'avvio: chi non vede il NAS non può usarla.
let codiceConfigurazione = null;
function serveConfigurazione() {
  const serve = Utenti.contaAdmin.get().n === 0;
  if (serve && !codiceConfigurazione) {
    codiceConfigurazione = crypto.randomBytes(4).toString('hex').toUpperCase();
    if (!process.env.POSTA_CARTELLA) console.log(`\n=== PRIMO AVVIO ===\nApri /configura nel browser e usa questo codice: ${codiceConfigurazione}\n`);
  }
  if (!serve) codiceConfigurazione = null;
  return serve;
}
setImmediate(serveConfigurazione);

router.use((req, res, next) => {
  if (req.path !== '/configura' && !req.path.startsWith('/css') && !req.path.startsWith('/img') && serveConfigurazione()) {
    return res.redirect('/configura');
  }
  next();
});

router.get('/configura', (req, res) => {
  if (!serveConfigurazione()) return res.redirect('/accedi');
  res.render('configura', { titolo: 'Primo avvio', errore: null, dati: {} });
});

router.post('/configura', auth.verificaCsrf, async (req, res, next) => {
  try {
    if (!serveConfigurazione()) return res.redirect('/accedi');
    const dati = { nome: String(req.body.nome || '').trim().slice(0, 200), email: String(req.body.email || '').trim().toLowerCase() };
    const render = (errore) => res.status(400).render('configura', { titolo: 'Primo avvio', errore, dati });
    if (auth.loginBloccato(req, 'configura')) return render('Troppi tentativi. Riprova tra un\'ora.');
    const codice = String(req.body.codice || '').trim().toUpperCase();
    if (codice.length !== codiceConfigurazione.length ||
        !crypto.timingSafeEqual(Buffer.from(codice), Buffer.from(codiceConfigurazione))) {
      auth.registraErrore(req, 'configura');
      return render('Codice non corretto. Lo trovi nel registro (log) del container.');
    }
    if (!dati.nome || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dati.email)) return render('Inserisci nome ed email validi.');
    const pw = String(req.body.password || '');
    if (pw.length < 12 || pw.length > 200) return render('La password deve avere tra 12 e 200 caratteri.');
    if (pw !== String(req.body.conferma || '')) return render('Le due password non coincidono.');
    Utenti.inserisci.run(dati.email, await auth.hashPassword(pw), dati.nome, null, 'admin');
    codiceConfigurazione = null;
    console.log(`Account studio creato dal primo avvio: ${dati.email}`);
    req.session.flash = { tipo: 'ok', msg: 'Account dello studio creato. Ora accedi.' };
    res.redirect('/accedi');
  } catch (e) { next(e); }
});

router.get('/', (req, res) => {
  if (config.soloArea) return res.redirect(req.utente ? '/area' : '/accedi');
  res.render('home', { titolo: null });
});

router.get('/privacy', (req, res) => res.render('privacy', { titolo: 'Privacy e cookie' }));

router.get('/accedi', (req, res) => {
  if (req.utente) return res.redirect(req.utente.ruolo === 'admin' ? '/studio' : '/area');
  const errore = req.query.scaduta ? `Sessione chiusa per inattività (dopo ${Math.round(config.inattivitaMs / 60000)} minuti senza attività). Accedi di nuovo.` : null;
  res.render('accedi', { titolo: 'Area clienti', errore, email: '', postaAttiva: posta.attiva });
});

router.post('/accedi', auth.verificaCsrf, (req, res, next) => auth.inFila(`accedi|${req.ip}`, async () => {
  try {
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    const errore = (msg) => res.status(401).render('accedi', { titolo: 'Area clienti', errore: msg, email, postaAttiva: posta.attiva });

    if (auth.loginBloccato(req, email) || auth.ipBloccato(req)) return errore('Troppi tentativi. Riprova tra un\'ora.');
    if (email.length > 200 || password.length > 200) return errore('Email o password non corretti.');
    const u = email ? Utenti.perEmail.get(email) : null;
    // Confronto sempre eseguito, anche se l'utente non esiste: stessi tempi di risposta
    const ok = (await auth.verificaPassword(password, u ? u.password_hash : auth.HASH_FINTO)) && u && u.attivo;
    if (!ok) {
      if (auth.registraErrore(req, email)) notifiche.avvisaBlocco(req, { email });
      if (auth.registraErroreIp(req)) notifiche.avvisaBlocco(req, { perIp: true });
      return errore('Email o password non corretti.');
    }
    auth.azzeraTentativi(req, email);
    const dopo = req.session.dopoLogin;
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.utenteId = u.id;
      Utenti.segnaAccesso.run(u.id);
      Utenti.segnaInformativa.run(u.id); // presa visione dell'informativa mostrata nella pagina di accesso
      const home = u.ruolo === 'admin' ? '/studio' : '/area';
      const sicuro = typeof dopo === 'string' && /^\/(?![/\\])[^\\\s]*$/.test(dopo) && dopo.length < 500;
      res.redirect(sicuro ? dopo : home);
    });
  } catch (e) { next(e); }
}));

// ---------- Password dimenticata ----------
router.get('/password-dimenticata', (req, res) => {
  if (!posta.attiva) return res.redirect('/accedi');
  res.render('password-dimenticata', { titolo: 'Password dimenticata', inviata: false, errore: null });
});

router.post('/password-dimenticata', auth.verificaCsrf, async (req, res, next) => {
  if (!posta.attiva) return res.redirect('/accedi');
  const email = String(req.body.email || '').trim().toLowerCase();
  // Limite di richieste: riusa il contatore dei tentativi di accesso, con una chiave a parte
  if (auth.loginBloccato(req, `reset|${email}`)) {
    return res.status(429).render('password-dimenticata', { titolo: 'Password dimenticata', inviata: false, errore: 'Troppe richieste. Riprova tra un\'ora.' });
  }
  auth.registraErrore(req, `reset|${email}`);
  try {
    const u = email ? Utenti.perEmail.get(email) : null;
    if (u && u.attivo) {
      const link = linkPassword.crea(u.id, 1, req);
      await posta.invia({
        a: u.email,
        oggetto: 'Reimposta la password dell\'area clienti',
        testo: `Gentile ${u.nome},\n\nabbiamo ricevuto una richiesta per reimpostare la password dell'area clienti.\nPer sceglierne una nuova apri questo link (valido 1 ora):\n\n${link}\n\nSe non sei stato tu, ignora questa email: la tua password non cambia.`,
      });
    }
    // Stessa risposta in ogni caso, per non rivelare quali email sono registrate
    res.render('password-dimenticata', { titolo: 'Password dimenticata', inviata: true, errore: null });
  } catch (e) { next(e); }
});

router.get('/imposta-password/:token', (req, res) => {
  const link = linkPassword.verifica(req.params.token);
  res.status(link ? 200 : 410).render('imposta-password', { titolo: 'Imposta la password', link, errore: null });
});

router.post('/imposta-password/:token', auth.verificaCsrf, async (req, res, next) => {
  try {
    const link = linkPassword.verifica(req.params.token);
    const render = (errore) => res.status(link ? 400 : 410).render('imposta-password', { titolo: 'Imposta la password', link, errore });
    if (!link) return render(null);
    const nuova = String(req.body.nuova || '');
    if (nuova.length < 10 || nuova.length > 200) return render('La password deve avere tra 10 e 200 caratteri.');
    if (nuova !== String(req.body.conferma || '')) return render('Le due password non coincidono.');
    const hash = await auth.hashPassword(nuova);
    if (!linkPassword.consuma(link.id)) return render(null);
    Utenti.impostaPassword.run(hash, link.utente_id);
    Utenti.segnaInformativa.run(link.utente_id);
    Utenti.terminaSessioni.run(link.utente_id);
    auth.azzeraEmail(link.email);
    req.session.flash = { tipo: 'ok', msg: 'Password impostata. Ora puoi accedere.' };
    res.redirect('/accedi');
  } catch (e) { next(e); }
});

// ---------- Caricamento documenti delle imprese (link personale del promemoria) ----------
const arrivi = require('../arrivi');
const tmpCarica = require('node:path').join(config.datiDir, 'tmp');
require('node:fs').mkdirSync(tmpCarica, { recursive: true });
const caricaImpresa = require('multer')({
  dest: tmpCarica,
  limits: { fileSize: arrivi.LIMITI.fileMb * 1024 * 1024, files: arrivi.LIMITI.filePerInvio, fields: 5, fieldSize: 500 },
}).array('file', arrivi.LIMITI.filePerInvio);

function paginaCarica(res, stato, dati) {
  const v = dati.v;
  res.status(stato).render('carica', {
    titolo: 'Invia documenti allo studio', v, esito: dati.esito || null, errore: dati.errore || null,
    documenti: v ? imprese.daSollecitare(v.impresa.id) : [], limiti: arrivi.LIMITI,
  });
}
const imprese = require('../imprese');

router.get('/carica/:token', (req, res) => {
  const v = arrivi.verificaLink(req.params.token);
  paginaCarica(res, v ? 200 : 410, { v });
});

router.post('/carica/:token', (req, res, next) => {
  // I file temporanei si cancellano sempre a fine richiesta
  res.on('close', () => { for (const f of req.files || []) if (f && f.path) require('node:fs').rm(f.path, { force: true }, () => {}); });
  const v = arrivi.verificaLink(req.params.token);
  if (!v) return paginaCarica(res, 410, { v: null });
  if (arrivi.troppiInvii(req.ip)) return paginaCarica(res, 429, { v, errore: 'Troppi invii in poco tempo: riprova tra un\'ora o contatta lo studio.' });
  caricaImpresa(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Ogni file può essere al massimo di ${arrivi.LIMITI.fileMb} MB.`
        : err.code === 'LIMIT_FILE_COUNT' ? `Puoi inviare al massimo ${arrivi.LIMITI.filePerInvio} file alla volta.` : 'Invio non riuscito: riprova.';
      return paginaCarica(res, 400, { v, errore: msg });
    }
    auth.verificaCsrf(req, res, async () => {
      try {
        const files = req.files || [];
        if (!files.length) return paginaCarica(res, 400, { v, errore: 'Scegli almeno un file.' });
        const esito = { salvati: [], rifiutati: [] };
        for (const f of files) {
          const nome = Buffer.from(f.originalname, 'latin1').toString('utf8');
          const r = await arrivi.ricevi(v.impresa.id, { percorso: f.path, nome, dimensione: f.size }, { origine: 'link' });
          if (r.ok) esito.salvati.push(nome); else esito.rifiutati.push({ nome, motivo: r.motivo });
          if (r.infetto) notifiche.avvisaStudio(`Antivirus: file scartato da ${v.impresa.ragione_sociale}`, `Il file «${nome}» caricato dal link dell'impresa ${v.impresa.ragione_sociale} è stato scartato dall'antivirus (${r.dettaglio}).\nNon è stato salvato. Se l'impresa ti contatta, chiedile di rimandarlo.`);
        }
        if (esito.salvati.length) {
          notifiche.avvisaStudio(`Documenti da ${v.impresa.ragione_sociale}`,
            `${v.impresa.ragione_sociale} ha caricato dal link del promemoria:\n\n${esito.salvati.map((n) => `- ${n}`).join('\n')}\n\nLi trovi da controllare nella scheda dell'impresa: ${notifiche.baseUrl(req)}/studio/imprese/${v.impresa.id}#arrivi`);
        }
        paginaCarica(res, 200, { v, esito });
      } catch (e) { next(e); }
    });
  });
});

router.post('/esci', auth.verificaCsrf, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('studio.sid');
    res.redirect('/');
  });
});

module.exports = router;
