'use strict';
const path = require('node:path');

// Tipi che il browser può mostrare in anteprima in sicurezza
const ANTEPRIMA = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
};

// Modelli 3D (pagine HTML preparate dallo studio): si aprono in una "sandbox" con origine separata,
// senza accesso ai cookie o all'area clienti; possono caricare solo la libreria 3D dai CDN indicati.
const CSP_MODELLO = [
  'sandbox allow-scripts allow-pointer-lock',
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  'img-src data: blob:',
  'connect-src https://cdn.jsdelivr.net https://cdnjs.cloudflare.com data: blob:',
  'worker-src blob:',
].join('; ');
const eModello3d = (nome) => /\.html?$/i.test(nome);

function anteprimaPossibile(nome) {
  return Boolean(ANTEPRIMA[path.extname(nome).toLowerCase()]) || eModello3d(nome);
}

/** Invia un file: in linea (anteprima) solo per i tipi sicuri, altrimenti come download. */
function inviaFile(res, abs, { scarica = false } = {}) {
  const nome = path.basename(abs);
  const tipo = ANTEPRIMA[path.extname(nome).toLowerCase()];
  const inLinea = !scarica && Boolean(tipo);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Il visualizzatore PDF di Chrome non funziona con la direttiva "sandbox"
  if (path.extname(nome).toLowerCase() === '.pdf') {
    res.removeHeader('Content-Security-Policy');
  } else {
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  }
  res.setHeader('Cache-Control', 'private, no-store');
  if (!scarica && eModello3d(nome)) {
    res.setHeader('Content-Security-Policy', CSP_MODELLO);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(nome)}`);
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    return res.sendFile(abs, { dotfiles: 'allow' });
  }
  if (inLinea) {
    res.setHeader('Content-Type', tipo);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(nome)}`);
    return res.sendFile(abs, { dotfiles: 'allow' });
  }
  return res.download(abs, nome, { dotfiles: 'allow' });
}

module.exports = { inviaFile, anteprimaPossibile, eModello3d };
