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
const pratiche = require('../src/pratiche');
const { Lavori, Pratiche } = require('../src/modelli');

const lavoro = { cartella: 'Ristrutturazione Mario Rossi' };
const base = path.join(process.env.ARCHIVIO_DIR, lavoro.cartella);

test('ogni sottocartella è una pratica; i file nascosti restano nascosti', async () => {
  await archivio.creaStruttura(lavoro);
  for (const d of ['Accesso atti', 'CILA', 'CILA/Variante', 'Parcelle', '_Bozze']) fs.mkdirSync(path.join(base, d), { recursive: true });
  fs.writeFileSync(path.join(base, 'CILA', 'cila.pdf'), 'x');
  fs.writeFileSync(path.join(base, 'CILA', 'Variante', 'v1.pdf'), 'x');
  fs.writeFileSync(path.join(base, 'CILA', '_bozza.pdf'), 'x');
  fs.writeFileSync(path.join(base, 'appunti.txt'), 'x'); // file nella radice: non è una pratica

  assert.deepStrictEqual(await archivio.sottocartelle(lavoro), ['Accesso atti', 'CILA', 'Parcelle']);
  const file = await archivio.documentiPratica(lavoro, 'CILA');
  assert.deepStrictEqual(file.map((f) => f.percorso), ['cila.pdf', 'Variante/v1.pdf']);
});

test('riconosce i tipi di pratica nel nome della cartella', () => {
  assert.ok(archivio.indiceTipo('CILA') >= 0);
  assert.ok(archivio.indiceTipo('02 - Accesso agli atti') < 0); // nome diverso: privata finché non la rendi visibile
  assert.ok(archivio.indiceTipo('02 - accesso atti') >= 0);
  assert.ok(archivio.indiceTipo('Agibilita') >= 0); // accenti ignorati
  assert.strictEqual(archivio.indiceTipo('Parcelle'), -1);
  assert.strictEqual(archivio.indiceTipo('CILAS'), -1);
});

test('sincronizza: tipi noti visibili, cartelle sconosciute private', async () => {
  const { lastInsertRowid } = Lavori.inserisci.run({
    codice: '2026-001', titolo: 'Ristrutturazione', descrizione: null, indirizzo: null, stato: 'In corso',
    cartella: lavoro.cartella, data_inizio: null, data_fine: null, visibile: 1,
  });
  const l = { ...lavoro, id: Number(lastInsertRowid) };
  const elenco = await pratiche.sincronizza(l);
  assert.deepStrictEqual(elenco.map((p) => [p.cartella, p.visibile]), [['Accesso atti', 1], ['CILA', 1], ['Parcelle', 0]]);

  const perCliente = await pratiche.conDocumenti(l, { soloVisibili: true });
  assert.deepStrictEqual(perCliente.map((p) => p.cartella), ['Accesso atti', 'CILA']);

  // Una cartella rinominata sul NAS sparisce dalla vista del cliente
  fs.renameSync(path.join(base, 'Accesso atti'), path.join(base, 'Accesso atti 2026'));
  const dopo = await pratiche.conDocumenti(l, { soloVisibili: true });
  assert.ok(!dopo.some((p) => p.cartella === 'Accesso atti'));
  assert.strictEqual(Pratiche.perLavoro.all(l.id).length, 4);
});

test('nome visibile senza numerazione', () => {
  assert.strictEqual(pratiche.nomeVisibile('006 - SCIA prot.18325 del 24-07-2025'), 'SCIA prot.18325 del 24-07-2025');
  assert.strictEqual(pratiche.nomeVisibile('015-APE'), 'APE');
  assert.strictEqual(pratiche.nomeVisibile('CILA'), 'CILA');
  assert.strictEqual(pratiche.nomeVisibile('2026'), '2026');
});

test('descrive lo stato con la data', () => {
  const f = (d) => d.split('-').reverse().join('/');
  assert.strictEqual(pratiche.descriviStato({ stato: 'Presentata', data: '2026-10-28' }, f), 'Presentata il 28/10/2026');
  assert.strictEqual(pratiche.descriviStato({ stato: 'Da fare', data: null }, f), 'Da fare');
});

test('blocca i percorsi fuori dalla pratica', () => {
  assert.ok(archivio.fileDocumento(lavoro, 'CILA', 'cila.pdf'));
  for (const f of ['../appunti.txt', '../../x', '/etc/passwd', '_bozza.pdf', '', '.']) {
    assert.strictEqual(archivio.fileDocumento(lavoro, 'CILA', f), null, f);
  }
  for (const p of ['../CILA', 'CILA/Variante', '_Bozze', '', '..']) {
    assert.strictEqual(archivio.cartellaPratica(lavoro, p), null, p);
  }
});

test('blocca i link simbolici che escono dall\'archivio', () => {
  fs.symlinkSync('/etc', path.join(base, 'CILA', 'fuga'));
  assert.strictEqual(archivio.fileDocumento(lavoro, 'CILA', 'fuga/hostname'), null);
});

test('crea la cartella di una nuova pratica con un nome sicuro', async () => {
  assert.strictEqual(await archivio.creaCartellaPratica(lavoro, 'Fine lavori'), 'Fine lavori');
  assert.ok(fs.statSync(path.join(base, 'Fine lavori')).isDirectory());
  assert.strictEqual(await archivio.creaCartellaPratica(lavoro, '../../fuori'), 'fuori');
  assert.ok(!fs.existsSync(path.join(process.env.ARCHIVIO_DIR, 'fuori')));
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
