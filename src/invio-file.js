'use strict';
const path = require('node:path');

// Tipi che il browser può mostrare in anteprima in sicurezza
const ANTEPRIMA = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
};

function anteprimaPossibile(nome) {
  return Boolean(ANTEPRIMA[path.extname(nome).toLowerCase()]);
}

/** Invia un file: in linea (anteprima) solo per i tipi sicuri, altrimenti come download. */
function inviaFile(res, abs, { scarica = false } = {}) {
  const nome = path.basename(abs);
  const tipo = ANTEPRIMA[path.extname(nome).toLowerCase()];
  const inLinea = !scarica && Boolean(tipo);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Il visualizzatore PDF di Chrome non funziona con la direttiva "sandbox"
  if (path.extname(nome).toLowerCase() !== '.pdf') {
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  }
  res.setHeader('Cache-Control', 'private, no-store');
  if (inLinea) {
    res.setHeader('Content-Type', tipo);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(nome)}`);
    return res.sendFile(abs, { dotfiles: 'allow' });
  }
  return res.download(abs, nome, { dotfiles: 'allow' });
}

module.exports = { inviaFile, anteprimaPossibile };
