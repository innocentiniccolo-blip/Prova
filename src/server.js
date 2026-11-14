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
  if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

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
  console.error(err);
  res.status(500).render('errore', { titolo: 'Errore', messaggio: 'Si è verificato un errore imprevisto.' });
});

if (require.main === module) {
  require('./automazioni').avvia();
  app.listen(config.port, () => {
    console.log(`Studio tecnico in ascolto su http://localhost:${config.port}`);
    console.log(`Archivio lavori: ${config.archivioDir}`);
  });
}

module.exports = app;
