'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const config = require('./config');
const sicurezza = require('./sicurezza');
const F = require('./formato');
const sinc = require('./sincronizza');
const { Email, Whatsapp } = require('./modelli');
const whatsapp = require('./whatsapp');

const app = express();
app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(sicurezza.soloLocale);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(session({
  name: 'cruscotto.sid',
  secret: crypto.randomBytes(32).toString('hex'), // nuovo a ogni avvio: basta ricaricare la pagina
  resave: false,
  saveUninitialized: true,
  cookie: { httpOnly: true, sameSite: 'strict' },
}));
app.use(sicurezza.csrf);
app.use((req, res, next) => {
  res.locals.studio = config.studio;
  res.locals.percorso = req.path;
  res.locals.flash = req.session.flash || null;
  res.locals.postaAttiva = config.posta.attiva;
  res.locals.driveNome = config.drive.nomeCartella;
  res.locals.nPosta = Email.contaDaRispondere.get().n;
  res.locals.nWhatsapp = Whatsapp.contaDaRispondere.get().n;
  delete req.session.flash;
  next();
});

app.locals.data = (d) => {
  if (!d) return '';
  const dt = /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00Z`) : new Date(String(d).replace(' ', 'T') + 'Z');
  return dt.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Rome' });
};
app.locals.dataOra = (d) => {
  if (!d) return '';
  return new Date(String(d).replace(' ', 'T') + 'Z').toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
};
app.locals.classeStato = (s) => 'stato-' + String(s).toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
app.locals.euro = F.euro;
app.locals.urgenza = (d) => F.urgenza(d);

app.use('/', require('./routes/pratiche'));
app.use('/clienti', require('./routes/clienti'));
app.use('/posta', require('./routes/posta'));
app.use('/whatsapp', require('./routes/whatsapp'));

app.use((req, res) => res.status(404).render('errore', { titolo: 'Pagina non trovata', messaggio: '' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('errore', { titolo: 'Errore', messaggio: 'Si è verificato un errore imprevisto.' });
});

if (require.main === module) {
  app.listen(config.port, config.host, () => {
    console.log('');
    console.log('  Cruscotto pratiche avviato.');
    console.log(`  Apri nel browser:  http://localhost:${config.port}`);
    console.log(`  Archivio:          ${path.join(config.datiDir, 'cruscotto.sqlite')}`);
    console.log(config.posta.attiva ? `  Posta:             ${config.posta.indirizzo}, controllo ogni ${config.posta.minuti} minuti` : '  Posta:             non collegata (vedi README)');
    const st = whatsapp.stato();
    console.log(st.attiva ? `  Google Drive:      ${require('./cartelle').radice()}` : '  Google Drive:      non trovato (vedi README)');
    if (st.attiva) console.log(`  WhatsApp:          controllo di "${st.cartella}" ogni ${st.minuti} minuti`);
    console.log('  Per chiudere: chiudi questa finestra (o premi Ctrl+C).');
    sinc.avvia();
    whatsapp.avvia();
    console.log('');
  }).on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`La porta ${config.port} è già in uso: forse il cruscotto è già aperto? Prova http://localhost:${config.port}`);
    else console.error(e);
    process.exit(1);
  });
}

module.exports = app;
