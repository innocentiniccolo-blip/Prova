'use strict';
/** Area riservata del cliente: vede solo i lavori a cui è associato. */
const express = require('express');
const auth = require('../auth');
const archivio = require('../archivio');
const pratiche = require('../pratiche');
const pubblicati = require('../pubblicati');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const config = require('../config');
const imprese = require('../imprese');
const richieste = require('../richieste');
const notifiche = require('../notifiche');
const { Lavori, Pratiche, Aggiornamenti, Accessi, Utenti } = require('../modelli');
const { inviaFile, anteprimaPossibile } = require('../invio-file');

const router = express.Router();
router.use(auth.richiediLogin);

// Caricamenti dei clienti: limiti più stretti di quelli dello studio
const tmpDir = path.join(config.datiDir, 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });
const caricaCliente = multer({
  dest: tmpDir,
  limits: { fileSize: richieste.LIMITI.fileMb * 1024 * 1024, files: richieste.LIMITI.filePerInvio, fields: 10, fieldSize: 2000 },
}).array('file', richieste.LIMITI.filePerInvio);
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
    // Al cliente solo visura, DURC e patente: gli altri documenti delle imprese (POS, attestati, idoneità…) restano allo studio
    const impreseCantiere = (lavoro.sicurezza ? imprese.impreseDelLavoro(lavoro.id, { soloVisibili: true }) : [])
      .map((i) => ({ ...i, nota: undefined, riepilogo: { ...i.riepilogo, altri: [] } }));
    const verbali = lavoro.sicurezza ? imprese.Q.verbali.all(lavoro.id).filter((v) => v.visibile) : [];
    res.render('area/lavoro', { titolo: lavoro.titolo, lavoro, richieste: richieste.elenco(lavoro.id).map((r) => {
      // Ogni cliente vede solo i nomi dei file che ha inviato lui; degli altri solo il numero
      const miei = req.utente.ruolo === 'admin' ? r.file : r.file.filter((f) => f.utente_id === req.utente.id);
      return { ...r, file: miei, altriFile: r.file.length - miei.length };
    }), limitiRichieste: richieste.LIMITI, estensioni: richieste.ESTENSIONI, pratiche: elenco, aggiornamenti, anteprimaPossibile, descriviStato: pratiche.descriviStato, impreseCantiere, verbali, tipiDoc: imprese.TIPI });
  } catch (e) { next(e); }
});

router.get('/lavori/:id/file', (req, res) => {
  const lavoro = lavoroAccessibile(req);
  const pratica = lavoro && Pratiche.perId.get(Number(req.query.p), lavoro.id);
  const rel = String(req.query.f || '');
  // Solo documenti pubblicati dallo studio: tutto il resto della cartella non è raggiungibile
  const abs = pratica && pubblicati.visibile(lavoro, pratica, rel) && archivio.fileDocumento(lavoro, pratica.cartella, rel);
  if (!abs) return res.status(404).render('errore', { titolo: 'File non trovato', messaggio: 'Il documento richiesto non è disponibile.' });
  Accessi.registra.run(lavoro.id, req.utente.id, `${pratica.cartella}/${rel}`);
  inviaFile(res, abs, { scarica: req.query.scarica === '1' });
});

// Documenti delle imprese del cantiere: solo se l'impresa è collegata al lavoro e visibile al cliente
router.get('/lavori/:id/imprese/:iid/documenti/:did', (req, res) => {
  const lavoro = lavoroAccessibile(req);
  const iid = Number(req.params.iid);
  const link = lavoro && lavoro.sicurezza && imprese.Q.collegamento.get(lavoro.id, iid);
  const doc = link && link.visibile && imprese.Q.documento.get(Number(req.params.did), iid);
  if (doc && doc.tipo === 'altro') return res.status(404).render('errore', { titolo: 'File non trovato', messaggio: 'Il documento richiesto non è disponibile.' });
  const abs = doc && imprese.percorsoFile(doc);
  if (!abs) return res.status(404).render('errore', { titolo: 'File non trovato', messaggio: 'Il documento richiesto non è disponibile.' });
  const imp = imprese.Q.perId.get(iid);
  Accessi.registra.run(lavoro.id, req.utente.id, `Sicurezza cantiere/${imp.ragione_sociale}/${imprese.TIPI[doc.tipo]}`);
  inviaFile(res, abs, { scarica: req.query.scarica === '1' });
});

router.get('/lavori/:id/verbali/:vid', (req, res) => {
  const lavoro = lavoroAccessibile(req);
  const v = lavoro && lavoro.sicurezza && imprese.Q.verbale.get(Number(req.params.vid), lavoro.id);
  const abs = v && v.visibile && imprese.percorsoVerbale(v);
  if (!abs) return res.status(404).render('errore', { titolo: 'File non trovato', messaggio: 'Il documento richiesto non è disponibile.' });
  Accessi.registra.run(lavoro.id, req.utente.id, `Sicurezza cantiere/Verbale ${v.tipo} del ${v.data}`);
  inviaFile(res, abs, { scarica: req.query.scarica === '1' });
});

// ---------- Documenti richiesti: il cliente carica i file ----------
function richiestaAperta(req, res, next) {
  const lavoro = lavoroAccessibile(req);
  const r = lavoro && richieste.Q.perId.get(Number(req.params.rid), lavoro.id);
  if (!r) return res.status(404).render('errore', { titolo: 'Richiesta non trovata', messaggio: 'La richiesta non esiste o non è associata al tuo account.' });
  req.lavoro = lavoro; req.richiesta = r;
  next();
}
const tornaAlLavoro = (req, res, tipo, msg) => {
  req.session.flash = { tipo, msg };
  res.redirect(`/area/lavori/${req.lavoro.id}#richieste`);
};

router.post('/lavori/:id/richieste/:rid/file', richiestaAperta, (req, res, next) => {
  // Controlli prima di accettare qualsiasi dato: richiesta ancora aperta e numero di invii
  if (req.richiesta.stato === 'completa') return tornaAlLavoro(req, res, 'errore', 'Questa richiesta è già stata chiusa dallo studio.');
  if (richieste.troppiInvii(req.utente.id)) return tornaAlLavoro(req, res, 'errore', 'Troppi invii in poco tempo. Riprova più tardi.');
  res.on('close', () => { for (const f of req.files || []) fs.rm(f.path, { force: true }, () => {}); });
  caricaCliente(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Un file supera il limite di ${richieste.LIMITI.fileMb} MB.`
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `Puoi inviare al massimo ${richieste.LIMITI.filePerInvio} file per volta.`
        : 'Caricamento non riuscito. Riprova.';
      return tornaAlLavoro(req, res, 'errore', msg);
    }
    next();
  });
}, auth.verificaCsrf, async (req, res, next) => {
  try {
    const files = req.files || [];
    if (!files.length) return tornaAlLavoro(req, res, 'errore', 'Scegli almeno un file da inviare.');
    const esito = await richieste.ricevi(req.lavoro, req.richiesta, files, req.utente.id);
    if (esito.salvati.length && req.utente.ruolo !== 'admin') {
      notifiche.avvisaStudio(`Documenti ricevuti: ${req.richiesta.titolo} – ${req.lavoro.codice}`,
        `${req.utente.nome} ha caricato ${esito.salvati.length} file per la richiesta «${req.richiesta.titolo}».\n\n`
        + `Lavoro: ${req.lavoro.codice} – ${req.lavoro.titolo}\nFile:\n${esito.salvati.map((n) => '  - ' + n).join('\n')}\n\n`
        + `Li trovi nella cartella del lavoro, in «${richieste.CARTELLA}/${req.richiesta.cartella}», e nel pannello:\n${notifiche.baseUrl(req)}/studio/lavori/${req.lavoro.id}#richieste`);
    }
    const scarti = esito.rifiutati.map((x) => `${x.nome} (${x.motivo})`).join('; ');
    if (!esito.salvati.length) return tornaAlLavoro(req, res, 'errore', `Nessun file inviato: ${scarti}.`);
    tornaAlLavoro(req, res, 'ok', `Inviat${esito.salvati.length === 1 ? 'o 1 file' : 'i ' + esito.salvati.length + ' file'} allo studio.${scarti ? ' Non accettati: ' + scarti + '.' : ''}`);
  } catch (e) { next(e); }
});

// Il cliente può togliere un file inviato per errore finché lo studio non chiude la richiesta
router.post('/lavori/:id/richieste/:rid/file/:fid/elimina', richiestaAperta, auth.verificaCsrf, async (req, res, next) => {
  try {
    const f = richieste.Q.fileId.get(Number(req.params.fid), req.richiesta.id);
    if (!f || req.richiesta.stato === 'completa') return tornaAlLavoro(req, res, 'errore', 'Il file non può più essere tolto: contatta lo studio.');
    if (req.utente.ruolo !== 'admin' && f.utente_id !== req.utente.id) return tornaAlLavoro(req, res, 'errore', 'Puoi togliere solo i file che hai inviato tu.');
    await richieste.eliminaFile(req.lavoro, req.richiesta, f);
    tornaAlLavoro(req, res, 'ok', 'File tolto.');
  } catch (e) { next(e); }
});

// Copia dei propri dati (diritto di accesso e portabilità, artt. 15 e 20 GDPR)
router.get('/profilo/dati', (req, res) => {
  const u = Utenti.perId.get(req.utente.id);
  const lavori = Utenti.lavori.all(u.id);
  const dati = {
    generato_il: new Date().toISOString(),
    titolare: { nome: config.studio.nomeBreve, indirizzo: config.studio.indirizzo, email: config.studio.email },
    account: { nome: u.nome, email: u.email, telefono: u.telefono, creato_il: u.creato_il, ultimo_accesso: u.ultimo_accesso, informativa_vista_il: u.informativa_il },
    lavori: lavori.map((l) => ({
      codice: l.codice, titolo: l.titolo, stato: l.stato,
      documenti_richiesti: richieste.elenco(l.id).map((r) => ({ richiesta: r.titolo, stato: r.stato, chiesto_il: r.creato_il,
        file_inviati: r.file.filter((f) => f.utente_id === u.id).map((f) => ({ nome: f.nome, dimensione: f.dimensione, inviato_il: f.caricato_il })) })),
    })),
    documenti_consultati: Accessi.perUtente.all(u.id),
    nota: 'I documenti delle pratiche sono scaricabili dall\'area clienti. Per rettifiche, cancellazione o altre richieste scrivi al titolare.',
  };
  res.setHeader('Content-Disposition', 'attachment; filename="i-miei-dati-area-clienti.json"');
  res.setHeader('Cache-Control', 'private, no-store');
  res.type('application/json').send(JSON.stringify(dati, null, 2));
});

router.get('/profilo', (req, res) => {
  res.render('area/profilo', { titolo: 'Il mio profilo', messaggio: null, errore: null });
});

router.post('/profilo/password', auth.verificaCsrf, async (req, res, next) => {
  try {
    const { attuale = '', nuova = '', conferma = '' } = req.body;
    const u = Utenti.perId.get(req.utente.id);
    const render = (errore, messaggio = null) => res.render('area/profilo', { titolo: 'Il mio profilo', errore, messaggio });
    if (auth.loginBloccato(req, `profilo|${u.id}`)) return render('Troppi tentativi. Riprova tra un\'ora.');
    if (attuale.length > 200 || !(await auth.verificaPassword(attuale, u.password_hash))) {
      if (auth.registraErrore(req, `profilo|${u.id}`)) require('../notifiche').avvisaBlocco(req, { email: u.email, dove: 'profilo' });
      return render('La password attuale non è corretta.');
    }
    if (nuova.length < 10 || nuova.length > 200) return render('La nuova password deve avere tra 10 e 200 caratteri.');
    if (nuova !== conferma) return render('Le due password non coincidono.');
    Utenti.impostaPassword.run(await auth.hashPassword(nuova), u.id);
    // Chiude le altre sessioni aperte con la vecchia password (resta valida solo questa)
    Utenti.terminaAltreSessioni.run(u.id, req.sessionID);
    render(null, 'Password aggiornata correttamente.');
  } catch (e) { next(e); }
});

module.exports = router;
