'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
process.env.ARCHIVIO_DIR = path.join(tmp, 'lavori');
process.env.DATI_DIR = path.join(tmp, 'app');
const archivio = require('../src/archivio');

const lavoro = { cartella: '2026-001 Prova' };

test('crea la struttura e mostra solo le categorie autorizzate', async () => {
  await archivio.creaStruttura(lavoro);
  const base = path.join(process.env.ARCHIVIO_DIR, lavoro.cartella);
  fs.writeFileSync(path.join(base, 'Progetti', 'tavola.pdf'), 'x');
  fs.mkdirSync(path.join(base, 'Progetti', 'Variante'));
  fs.writeFileSync(path.join(base, 'Progetti', 'Variante', 'v1.pdf'), 'x');
  fs.writeFileSync(path.join(base, 'Progetti', '_bozza.pdf'), 'x');
  fs.mkdirSync(path.join(base, 'Interno'));
  fs.writeFileSync(path.join(base, 'Interno', 'parcella.pdf'), 'x');

  const cats = await archivio.documentiLavoro(lavoro);
  const progetti = cats.find((c) => c.chiave === 'progetti');
  assert.deepStrictEqual(progetti.file.map((f) => f.percorso), ['tavola.pdf', 'Variante/v1.pdf']);
  const tutti = cats.flatMap((c) => c.file.map((f) => f.nome));
  assert.ok(!tutti.includes('parcella.pdf'));
  assert.ok(!tutti.includes('_bozza.pdf'));
});

test('blocca i percorsi fuori dalla categoria', () => {
  assert.ok(archivio.fileDocumento(lavoro, 'progetti', 'tavola.pdf'));
  for (const f of ['../Interno/parcella.pdf', '../../x', '/etc/passwd', '_bozza.pdf', '', '.']) {
    assert.strictEqual(archivio.fileDocumento(lavoro, 'progetti', f), null, f);
  }
  assert.strictEqual(archivio.fileDocumento(lavoro, 'inesistente', 'tavola.pdf'), null);
});

test('blocca i link simbolici che escono dall\'archivio', () => {
  const base = path.join(process.env.ARCHIVIO_DIR, lavoro.cartella, 'Progetti');
  fs.symlinkSync('/etc', path.join(base, 'fuga'));
  assert.strictEqual(archivio.fileDocumento(lavoro, 'progetti', 'fuga/hostname'), null);
});

test('normalizza le cartelle dei lavori', () => {
  assert.strictEqual(archivio.normalizzaCartella(' 2026 / 2026-002 Rossi '), '2026/2026-002 Rossi');
  assert.strictEqual(archivio.normalizzaCartella('..\\..\\etc'), null);
  assert.strictEqual(archivio.normalizzaCartella(''), null);
});

test('nomi file sicuri', () => {
  assert.strictEqual(archivio.nomeSicuro('../../evil.pdf'), 'evil.pdf');
  assert.strictEqual(archivio.nomeSicuro('.htaccess'), 'htaccess');
  assert.strictEqual(archivio.nomeSicuro('Pianta: piano 1?.pdf'), 'Pianta_ piano 1_.pdf');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
