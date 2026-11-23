'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cruscotto-posta-'));
process.env.DATI_DIR = tmp;
delete process.env.EMAIL_INDIRIZZO;
delete process.env.ANTHROPIC_API_KEY;

const { abbina, contieneCodice } = require('../src/abbina');
const { analizza } = require('../src/posta');
const app = require('../src/server');

const pratiche = [
  { id: 1, cliente_id: 10, tipo: 'SCIA', protocollo: '28451', numero_pratica: 'SCIA 145/2026', commessa: '2026-014' },
  { id: 2, cliente_id: 10, tipo: 'DOCFA', protocollo: '', numero_pratica: '', commessa: '2026-014' },
  { id: 3, cliente_id: 20, tipo: 'APE', protocollo: '123', numero_pratica: '', commessa: '2026-020' },
];

test('codici cercati come parole intere', () => {
  assert.ok(contieneCodice('Rif. prot. n. 28451 del 20/10', '28451'));
  assert.ok(!contieneCodice('telefono 3328451999', '28451'));
  assert.ok(contieneCodice('Commessa 2026-014.', '2026-014'));
});

test('abbina per protocollo anche se il mittente non è in rubrica', () => {
  const r = abbina({ oggetto: 'Richiesta integrazioni prot. 28451', testo: '' }, { cliente: null, pratiche });
  assert.deepStrictEqual(r, { cliente_id: null, pratica_id: 1 });
});

test('protocollo più specifico vince sulla commessa condivisa', () => {
  const r = abbina({ oggetto: 'Commessa 2026-014', testo: 'pratica SCIA 145/2026' }, { cliente: { id: 10 }, pratiche });
  assert.strictEqual(r.pratica_id, 1);
});

test('cliente con una sola pratica aperta', () => {
  assert.deepStrictEqual(abbina({ oggetto: 'Ciao', testo: 'novità?' }, { cliente: { id: 20 }, pratiche }), { cliente_id: 20, pratica_id: 3 });
});

test('cliente con più pratiche e nessun codice: pratica da scegliere', () => {
  assert.deepStrictEqual(abbina({ oggetto: 'Ciao', testo: 'novità?' }, { cliente: { id: 10 }, pratiche }), { cliente_id: 10, pratica_id: null });
});

test('numeri corti non generano abbinamenti', () => {
  assert.deepStrictEqual(abbina({ oggetto: 'Fattura 123', testo: '' }, { cliente: null, pratiche }), { cliente_id: null, pratica_id: null });
});

test('lettura di una mail HTML con accenti e risposta-a', async () => {
  const raw = Buffer.from([
    'From: =?UTF-8?Q?Mario_Ross=C3=AC?= <Mario@Rossi.IT>',
    'Reply-To: segreteria@rossi.it',
    'To: info@geometrainnocenti.it',
    'Subject: =?UTF-8?Q?Pratica_gi=C3=A0_presentata=3F?=',
    'Message-ID: <abc@rossi.it>',
    'References: <x@y> <z@w>',
    'Date: Mon, 23 Nov 2026 10:00:00 +0100',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Buongiorno,<br>la pratica è già presentata?</p><script>alert(1)</script>',
  ].join('\r\n'));
  const m = await analizza(7, raw);
  assert.strictEqual(m.uid, 7);
  assert.strictEqual(m.mittente_email, 'mario@rossi.it');
  assert.strictEqual(m.mittente_nome, 'Mario Rossì');
  assert.strictEqual(m.rispondi_a, 'segreteria@rossi.it');
  assert.strictEqual(m.oggetto, 'Pratica già presentata?');
  assert.strictEqual(m.message_id, '<abc@rossi.it>');
  assert.strictEqual(m.riferimenti, '<x@y> <z@w>');
  assert.match(m.testo, /la pratica è già presentata\?/);
  assert.doesNotMatch(m.testo, /<p>|alert/);
});

test('pagina Posta senza casella configurata mostra le istruzioni', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((ok) => server.once('listening', ok));
  t.after(() => server.close());
  const r = await fetch(`http://localhost:${server.address().port}/posta`);
  assert.strictEqual(r.status, 200);
  const html = await r.text();
  assert.match(html, /Collega la casella di posta/);
  assert.match(html, /EMAIL_INDIRIZZO=info@geometrainnocenti\.it/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
