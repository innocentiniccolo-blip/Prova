'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cruscotto-drive-'));
const drive = path.join(tmp, 'Il mio Drive', 'Studio Innocenti');
fs.mkdirSync(path.join(drive, 'Sofia Forzini', '002-Computo'), { recursive: true });
fs.mkdirSync(path.join(drive, '_WhatsApp da importare'), { recursive: true });
fs.writeFileSync(path.join(drive, 'Sofia Forzini', 'Planimetria.pdf'), 'x');
fs.writeFileSync(path.join(drive, 'Sofia Forzini', 'desktop.ini'), 'x');
process.env.DATI_DIR = path.join(tmp, 'dati');
process.env.DRIVE_DIR = drive;
delete process.env.EMAIL_INDIRIZZO;

const cartelle = require('../src/cartelle');
const app = require('../src/server');

test('trova la cartella dello studio ed elenca quelle dei clienti', async () => {
  assert.ok(cartelle.attiva());
  const elenco = await cartelle.cartelleStudio();
  assert.ok(elenco.includes('Sofia Forzini'));
  assert.ok(!elenco.includes('_WhatsApp da importare')); // le cartelle "_" sono di servizio
});

test('percorsi: niente uscite dalla cartella dello studio', () => {
  assert.strictEqual(cartelle.normalizza(' Sofia Forzini \\ 002-Computo '), 'Sofia Forzini/002-Computo');
  assert.strictEqual(cartelle.normalizza('../Windows'), null);
  assert.strictEqual(cartelle.normalizza('Rossi: casa?'), null);
  assert.strictEqual(cartelle.normalizza(''), null);
  assert.strictEqual(cartelle.risolvi('../../etc'), null);
  assert.ok(cartelle.risolvi('Sofia Forzini'));
});

test('contenuto: cartelle in ordine numerico, file nascosti esclusi', async () => {
  const { voci } = await cartelle.contenuto('Sofia Forzini');
  assert.deepStrictEqual(voci.map((v) => v.nome), ['002-Computo', 'Planimetria.pdf']);
});

test('crea con sottocartelle standard e salva senza sovrascrivere', async () => {
  await cartelle.crea('Mario Rossi - Montevarchi', true);
  assert.ok(fs.existsSync(path.join(drive, 'Mario Rossi - Montevarchi', '001-Rilievo')));
  assert.ok(fs.existsSync(path.join(drive, 'Mario Rossi - Montevarchi', '010-Fatture')));
  const t = path.join(tmp, 'up.txt');
  fs.writeFileSync(t, 'a');
  assert.strictEqual(await cartelle.salva('Mario Rossi - Montevarchi/001-Rilievo', t, 'rilievo.txt'), 'rilievo.txt');
  assert.strictEqual(await cartelle.salva('Mario Rossi - Montevarchi/001-Rilievo', t, 'rilievo.txt'), 'rilievo (2).txt');
  assert.strictEqual(await cartelle.salva('Mario Rossi - Montevarchi', t, '../../evil.txt'), 'evil.txt');
});

test('pratica collegata alla cartella: creazione, elenco file e caricamento', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((ok) => server.once('listening', ok));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  let cookie = '';
  const vai = async (url, opz = {}) => {
    const r = await fetch(base + url, { ...opz, headers: { ...(opz.headers || {}), cookie }, redirect: 'manual' });
    const sc = r.headers.getSetCookie(); if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  };
  let r = await vai('/pratiche/nuova');
  assert.match(r.text, /<option value="Sofia Forzini">/);
  const csrf = r.text.match(/name="csrf" content="([^"]+)"/)[1];

  const form = new URLSearchParams({ _csrf: csrf, tipo: 'SCIA', stato: 'Presentata', nuovo_cliente_nome: 'Luca Bianchi', cartella: 'Luca Bianchi', crea_cartella: '1' });
  r = await vai('/pratiche', { method: 'POST', body: form, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.strictEqual(r.status, 302);
  assert.ok(fs.existsSync(path.join(drive, 'Luca Bianchi', '006-Pratiche')));
  const url = r.location;

  const fd = new FormData();
  fd.append('_csrf', csrf);
  fd.append('sottocartella', '006-Pratiche');
  fd.append('file', new Blob(['%PDF']), 'Ricevuta protocollo è.pdf');
  r = await vai(`${url}/cartella/carica`, { method: 'POST', body: fd });
  assert.strictEqual(r.status, 302);
  assert.ok(fs.existsSync(path.join(drive, 'Luca Bianchi', '006-Pratiche', 'Ricevuta protocollo è.pdf')));

  r = await vai(url);
  assert.match(r.text, /Cartella su Google Drive/);
  assert.match(r.text, /Ricevuta protocollo è\.pdf/);
  assert.match(r.text, /001-Rilievo/);

  // Sottocartella malevola rifiutata
  const fd2 = new FormData();
  fd2.append('_csrf', csrf);
  fd2.append('sottocartella', '../../');
  fd2.append('file', new Blob(['x']), 'x.txt');
  r = await vai(`${url}/cartella/carica`, { method: 'POST', body: fd2 });
  assert.strictEqual(r.status, 302);
  assert.ok(!fs.existsSync(path.join(tmp, 'x.txt')) && !fs.existsSync(path.join(tmp, 'Il mio Drive', 'x.txt')));
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
