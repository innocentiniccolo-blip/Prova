'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-link-'));
process.env.ARCHIVIO_DIR = path.join(tmp, 'lavori');
process.env.DATI_DIR = path.join(tmp, 'app');
const linkPassword = require('../src/link-password');
const { Utenti } = require('../src/modelli');

const req = { protocol: 'http', get: () => 'localhost:3000' };
const { lastInsertRowid: id } = Utenti.inserisci.run('mario@esempio.it', 'x', 'Mario Rossi', '', 'cliente');
const token = (url) => url.split('/imposta-password/')[1];

test('un link si usa una sola volta', () => {
  const url = linkPassword.crea(Number(id), 1, req);
  assert.match(url, /^http:\/\/localhost:3000\/imposta-password\/[A-Za-z0-9_-]{40,}$/);
  const l = linkPassword.verifica(token(url));
  assert.strictEqual(l.email, 'mario@esempio.it');
  assert.ok(linkPassword.consuma(l.id));
  assert.strictEqual(linkPassword.verifica(token(url)), null);
  assert.ok(!linkPassword.consuma(l.id));
});

test('un nuovo link annulla il precedente; token non validi rifiutati', () => {
  const vecchio = linkPassword.crea(Number(id), 1, req);
  const nuovo = linkPassword.crea(Number(id), 1, req);
  assert.strictEqual(linkPassword.verifica(token(vecchio)), null);
  assert.ok(linkPassword.verifica(token(nuovo)));
  for (const t of ['', 'abc', '../../x', 'a'.repeat(200)]) assert.strictEqual(linkPassword.verifica(t), null);
});

test('i link scaduti o di clienti disattivati non valgono', () => {
  const scaduto = linkPassword.crea(Number(id), -1, req);
  assert.strictEqual(linkPassword.verifica(token(scaduto)), null);
  const url = linkPassword.crea(Number(id), 1, req);
  Utenti.aggiorna.run('mario@esempio.it', 'Mario Rossi', '', 0, Number(id));
  assert.strictEqual(linkPassword.verifica(token(url)), null);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
