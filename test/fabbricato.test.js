'use strict';
// Dati inventati: nessun documento reale dei clienti
process.env.DATI_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'fab-'));
const test = require('node:test');
const assert = require('node:assert');
const f = require('../src/fabbricato');

test('dati catastali dalla relazione e dalla tabella della visura', () => {
  const u = f.catasto('censito al Catasto Fabbricati al foglio 12, particella 345, subalterno 6, categoria A/2, classe 3, consistenza 6,5 vani, rendita Euro 520,00.');
  assert.deepStrictEqual(u[0], { foglio: '12', particella: '345', sub: '6', categoria: 'A/2', classe: '3', consistenza: '6,5 vani', rendita: '€ 520,00' });
  const v = f.catasto('Foglio Particella Sub Categoria Classe Consistenza Rendita\n8 77 2 C/6 1 18 m² Totale: 20 m² Euro 45,10');
  assert.strictEqual(v[0].categoria, 'C/6');
  assert.strictEqual(v[0].consistenza, '18 mq');
});

test('indirizzo dell\'immobile, non dello studio né della residenza', () => {
  assert.strictEqual(f.indirizzo('Viale Marconi n. 38. Committente residente in Via Verdi n. 5. Immobile sito in Castelfranco, Via Roma n. 12', ['viale marconi']), 'Via Roma 12');
  assert.strictEqual(f.comune('Comune di Castelfranco Piandiscò (AR) foglio 3'), 'Castelfranco Piandiscò');
});

test('esito della relazione e titoli edilizi', () => {
  assert.strictEqual(f.esitoRelazione('Non sono state rilevate difformità'), 'conforme');
  assert.strictEqual(f.esitoRelazione('Si rilevano le seguenti difformità: diversa distribuzione'), 'difforme');
  assert.strictEqual(f.esitoRelazione('Premessa e rilievo'), '');
  assert.deepStrictEqual(f.titoli('Licenza edilizia n. 45 del 12/03/1972 e S.C.I.A. n. 33/2015'), ['Licenza edilizia n. 45 del 12/03/1972', 'SCIA n. 33/2015']);
});

test('APE: classe, EP e validità', () => {
  assert.deepStrictEqual(f.ape('CLASSE ENERGETICA D EPgl,nren 98,5 kWh/m2 anno VALIDO FINO AL: 01/02/2034'), { classe: 'D', ep: '98,5', scadenza: '2034-02-01', codice: '' });
  assert.strictEqual(f.ape('Data di emissione: 10/05/2026 Classe energetica A2').scadenza, '2036-05-10');
  assert.strictEqual(f.ape('classe e consistenza').classe, '');
});

test('PDF dentro la busta firmata p7m', () => {
  const pdf = f.pdfDaP7m(Buffer.concat([Buffer.from([0x30, 0x80, 1, 2]), Buffer.from('%PDF-1.4 contenuto %%EOF'), Buffer.from([0xa0, 0, 0])]));
  assert.strictEqual(pdf.toString(), '%PDF-1.4 contenuto %%EOF');
});

test('fascicolo PDF su carta intestata', async () => {
  const { creaPdf } = require('../src/fascicoloPdf');
  const buf = await creaPdf({ titolo: 'Prova', indirizzo: 'Via Roma 12', comune: 'Montevarchi', coordinate: '', mappa: 'https://www.google.com/maps/search/?api=1&query=Via%20Roma%2012',
    catasto: [{ foglio: '1', particella: '2', sub: '3', categoria: 'A/2', classe: '1', consistenza: '5 vani', rendita: '€ 300,00' }], catastoTesto: '',
    catastale: { testo: 'Da verificare', tono: 'neutro' }, urbanistica: { testo: 'In fase di valutazione', tono: 'attesa', nota: '', titoli: [], fonte: '' },
    ape: { classe: 'C', ep: '80', scadenza: '2035-01-01', codice: '' }, descrizione: 'Appartamento di prova.', pratiche: [], nota: '' }, (d) => d.split('-').reverse().join('/'));
  assert.strictEqual(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.length > 3000);
});

test('cartella madre Drive: elenco dei lavori confermati per lo script di copia', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const config = require('../src/config');
  config.archivioSolaLettura = true;
  const db = require('../src/db');
  db.prepare("INSERT INTO lavori (codice, titolo, stato, cartella, visibile) VALUES ('T-1', 'Prova', 'In corso', 'Rossi Mario - Via Roma', 1), ('T-2', 'Prova 2', 'In corso', 'Bianchi/Sotto', 1)").run();
  require('../src/automazioni').scriviLavoriDrive();
  assert.deepStrictEqual(fs.readFileSync(path.join(config.datiDir, 'drive-lavori.txt'), 'utf8').trim().split('\n'), ['Bianchi', 'Rossi Mario - Via Roma']);
  config.archivioSolaLettura = false;
});
