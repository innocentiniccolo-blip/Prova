'use strict';
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const config = require('./config');
const SqliteStore = require('./session-store');
const auth = require('./auth');

const app = express();
app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
if (config.trustProxy) app.set('trust proxy', config.trustProxy === 'true' ? 1 : config.trustProxy);

// Intestazioni di sicurezza di base
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Area riservata: nessuna pagina deve finire nei motori di ricerca
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  // Nessuno script esterno o in linea: tutto il codice della pagina sta in /js/app.js
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.produzione ? '7d' : 0 }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(session({
  name: 'studio.sid',
  store: new SqliteStore(),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 8 * 60 * 60 * 1000 },
}));

app.use(auth.csrf);
app.use(auth.caricaUtente);
app.use((req, res, next) => {
  res.locals.studio = config.studio;
  res.locals.percorso = req.path;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

// Valori predefiniti per le viste (servono anche per gli errori che avvengono prima della sessione)
Object.assign(app.locals, { studio: config.studio, percorso: '', flash: null, utente: null, csrf: '' });

// Helper per le viste
app.locals.dimensione = (b) => {
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB'];
  let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return `${b.toFixed(b < 10 ? 1 : 0).replace('.', ',')} ${u[i]}`;
};
app.locals.data = (d) => {
  if (!d) return '';
  const dt = typeof d === 'string' && !d.includes('T') && d.length > 10 ? new Date(d.replace(' ', 'T') + 'Z') : new Date(d);
  return dt.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
};
app.locals.dataOra = (d) => {
  if (!d) return '';
  const dt = typeof d === 'string' ? new Date(d.replace(' ', 'T') + 'Z') : new Date(d);
  return dt.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'Europe/Rome' });
};
app.locals.classeStato = (s) => 'stato-' + String(s).toLowerCase().replace(/[^a-z]+/g, '-');

app.use('/', require('./routes/pubblico'));
app.use('/area', require('./routes/area'));
app.use('/studio', require('./routes/studio'));

app.use((req, res) => res.status(404).render('errore', { titolo: 'Pagina non trovata', messaggio: 'La pagina richiesta non esiste.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).render('errore', { titolo: 'File troppo grande', messaggio: `Il limite è ${config.maxUploadMb} MB per file.` });
  }
  // Richieste malformate (indirizzo non decodificabile, corpo troppo grande, multipart rotto): errore del client
  const stato = Number(err.status || err.statusCode) || (err.name === 'MulterError' || /Unexpected end of form|Multipart|Malformed part/i.test(err.message || '') ? 400 : 0);
  if (stato >= 400 && stato < 500) {
    return res.status(stato).render('errore', { titolo: 'Richiesta non valida', messaggio: 'La richiesta non è valida.' });
  }
  console.error(err);
  res.status(500).render('errore', { titolo: 'Errore', messaggio: 'Si è verificato un errore imprevisto.' });
});

if (require.main === module) {
  // Un errore imprevisto in un'operazione in background non deve spegnere il servizio
  require('./pulizia').avvia();
  process.on('unhandledRejection', (e) => console.error('Errore non gestito:', e));
  require('./automazioni').avvia();
  app.listen(config.port, () => {
    console.log(`Studio tecnico in ascolto su http://localhost:${config.port}`);
    console.log(`Archivio lavori: ${config.archivioDir}`);
  });
}

module.exports = app;
