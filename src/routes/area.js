'use strict';
/** Area riservata del cliente: vede solo i lavori a cui è associato. */
const express = require('express');
const auth = require('../auth');
const archivio = require('../archivio');
const pratiche = require('../pratiche');
const { Lavori, Pratiche, Aggiornamenti, Accessi, Utenti } = require('../modelli');
const { inviaFile, anteprimaPossibile } = require('../invio-file');

const router = express.Router();
router.use(auth.richiediLogin);

/** Lo staff può vedere l'area come la vedrebbe un cliente (anteprima). */
function lavoroAccessibile(req) {
  const id = Number(req.params.id);
  if (req.utente.ruolo === 'admin') return Lavori.perId.get(id);
  return Lavori.delCliente.get(id, req.utente.id);
}

router.get('/', (req, res) => {
  if (req.utente.ruolo === 'admin') return res.redirect('/studio');
  const lavori = Lavori.perCliente.all(req.utente.id);
  res.render('area/lavori', { titolo: 'I miei lavori', lavori });
});

router.get('/lavori/:id', async (req, res, next) => {
  try {
    const lavoro = lavoroAccessibile(req);
    if (!lavoro) return res.status(404).render('errore', { titolo: 'Lavoro non trovato', messaggio: 'Il lavoro richiesto non esiste o non è associato al tuo account.' });
    // Anche lo studio, in anteprima, vede solo ciò che vede il cliente
    const elenco = await pratiche.conDocumenti(lavoro, { soloVisibili: true });
    const aggiornamenti = Aggiornamenti.perLavoro.all(lavoro.id);
    res.render('area/lavoro', { titolo: lavoro.titolo, lavoro, pratiche: elenco, aggiornamenti, anteprimaPossibile, descriviStato: pratiche.descriviStato });
  } catch (e) { next(e); }
});

router.get('/lavori/:id/file', (req, res) => {
  const lavoro = lavoroAccessibile(req);
  const pratica = lavoro && Pratiche.perId.get(Number(req.query.p), lavoro.id);
  const rel = String(req.query.f || '');
  const abs = pratica && pratica.visibile && archivio.fileDocumento(lavoro, pratica.cartella, rel);
  if (!abs) return res.status(404).render('errore', { titolo: 'File non trovato', messaggio: 'Il documento richiesto non è disponibile.' });
  Accessi.registra.run(lavoro.id, req.utente.id, `${pratica.cartella}/${rel}`);
  inviaFile(res, abs, { scarica: req.query.scarica === '1' });
});

router.get('/profilo', (req, res) => {
  res.render('area/profilo', { titolo: 'Il mio profilo', messaggio: null, errore: null });
});

router.post('/profilo/password', auth.verificaCsrf, async (req, res, next) => {
  try {
    const { attuale = '', nuova = '', conferma = '' } = req.body;
    const u = Utenti.perId.get(req.utente.id);
    const render = (errore, messaggio = null) => res.render('area/profilo', { titolo: 'Il mio profilo', errore, messaggio });
    if (!(await auth.verificaPassword(attuale, u.password_hash))) return render('La password attuale non è corretta.');
    if (nuova.length < 10) return render('La nuova password deve avere almeno 10 caratteri.');
    if (nuova !== conferma) return render('Le due password non coincidono.');
    Utenti.impostaPassword.run(await auth.hashPassword(nuova), u.id);
    render(null, 'Password aggiornata correttamente.');
  } catch (e) { next(e); }
});

module.exports = router;
