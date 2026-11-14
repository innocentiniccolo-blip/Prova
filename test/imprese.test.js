'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-imprese-'));
process.env.ARCHIVIO_DIR = path.join(tmp, 'lavori');
process.env.DATI_DIR = path.join(tmp, 'app');
const imprese = require('../src/imprese');

const iso = (giorni) => { const d = new Date(); d.setDate(d.getDate() + giorni); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('scadenze predefinite: DURC 120 giorni, visura 6 mesi', () => {
  assert.strictEqual(imprese.scadenzaPredefinita('durc', '2026-01-10'), '2026-05-10');
  assert.strictEqual(imprese.scadenzaPredefinita('visura', '2026-01-10'), '2026-07-10');
  assert.strictEqual(imprese.scadenzaPredefinita('patente', '2026-01-10'), null);
});

test('stato dei documenti', () => {
  assert.strictEqual(imprese.statoDocumento(null).codice, 'mancante');
  assert.strictEqual(imprese.statoDocumento({ tipo: 'durc', scadenza: iso(-1) }).codice, 'scaduto');
  assert.strictEqual(imprese.statoDocumento({ tipo: 'durc', scadenza: iso(10) }).codice, 'in-scadenza');
  assert.strictEqual(imprese.statoDocumento({ tipo: 'durc', scadenza: iso(60) }).codice, 'ok');
  assert.strictEqual(imprese.statoDocumento({ tipo: 'patente', crediti: 14 }).codice, 'insufficiente');
  assert.strictEqual(imprese.statoDocumento({ tipo: 'patente', crediti: 30 }).codice, 'ok');
});

test('riepilogo usa il documento più recente di ogni tipo', async () => {
  const id = Number(imprese.Q.inserisci.run({ ragione_sociale: 'Prova srl', piva: null, sede: null, pec: null, telefono: null, autonomo: 0, nota: null }).lastInsertRowid);
  await imprese.salvaDocumento(id, { tipo: 'durc', rilascio: iso(-200) });
  await imprese.salvaDocumento(id, { tipo: 'durc', rilascio: iso(-5) });
  const r = imprese.riepilogo(id);
  assert.strictEqual(r.durc.stato.codice, 'ok');
  assert.strictEqual(r.visura.stato.codice, 'mancante');
  assert.strictEqual(r.problemi, 2);
});
