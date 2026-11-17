'use strict';
// Visure catastali automatiche. Dati inventati: nessun documento reale dei clienti.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-visure-'));
process.env.ARCHIVIO_DIR = path.join(tmp, 'lavori');
process.env.DATI_DIR = path.join(tmp, 'app');
fs.mkdirSync(process.env.ARCHIVIO_DIR, { recursive: true });

const PDFDocument = require('pdfkit');
const visure = require('../src/visure');
const pubblicati = require('../src/pubblicati');
const pratiche = require('../src/pratiche');
const archivio = require('../src/archivio');
const { Lavori, db } = require('../src/modelli');

function pdf(file, righe) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return new Promise((ok) => {
    const doc = new PDFDocument({ size: 'A4' });
    const out = fs.createWriteStream(file);
    out.on('finish', ok);
    doc.pipe(out);
    doc.fontSize(9);
    for (const r of righe) doc.text(r);
    doc.end();
  });
}
const visura = (data, f, p, s, tipo = 'immobile') => [
  `Visura ${tipo === 'storica' ? 'storica ' : ''}per immobile`, `Visura n.: T000 Data: ${data}`,
  'Dati della richiesta', 'Comune di MONTEVARCHI (Codice: F656)', 'Catasto Fabbricati', `Foglio: ${f} Particella: ${p} Sub.: ${s}`,
  'INTESTATO', 'ROSSI Mario nato a ESEMPIO', 'Unità immobiliare', `${f} ${p} ${s} A/2 3 6,5 vani Euro 520,00`];

test('identificativi catastali, con e senza contesto', () => {
  assert.deepStrictEqual(visure.identificativi('censito al foglio 12, particella 345, sub. 6 e 7'), [{ f: '12', p: '345', s: '6' }, { f: '12', p: '345', s: '7' }]);
  assert.deepStrictEqual(visure.identificativi('fg. 3 part. 88'), [{ f: '3', p: '88', s: '' }]);
  const rel = 'Immobile censito al Catasto Fabbricati al foglio 12 particella 345 subalterno 6. Confina con foglio 12 particella 346 e strada.';
  assert.deepStrictEqual(visure.identificativi(rel, { contesto: true }), [{ f: '12', p: '345', s: '6' }]);
  assert.strictEqual(visure.tipoCatastale('Visura per soggetto\nDati della richiesta Cognome: ROSSI'), 'soggetto');
  assert.strictEqual(visure.tipoCatastale(visura('10/11/2026', 12, 345, 6).join('\n')), 'immobile');
  assert.strictEqual(visure.tipoCatastale('Catasto dei Fabbricati - Planimetria di u.i.u. in Comune di Montevarchi'), 'planimetria');
  assert.ok(visure.corrisponde({ f: '12', p: '345', s: '6' }, { f: '12', p: '345', s: '' }));
  assert.ok(!visure.corrisponde({ f: '12', p: '345', s: '6' }, { f: '12', p: '345', s: '9' }));
});

test('DOCFA: il sub soppresso non è più l\'unità d\'intervento', () => {
  const d = visure.unitaDocFonte('Ricevuta DOCFA - dichiarazione di variazione\nUnità soppressa: foglio 12 particella 345 sub 6\nUnità costituita: foglio 12 particella 345 sub 10');
  assert.deepStrictEqual(d.unita, [{ f: '12', p: '345', s: '10' }]);
  assert.deepStrictEqual(d.soppresse, [{ f: '12', p: '345', s: '6' }]);
});

test('pubblica solo la visura più recente dell\'unità d\'intervento', async () => {
  const cartella = 'Rossi Mario - Via Roma';
  const base = path.join(process.env.ARCHIVIO_DIR, cartella);
  await pdf(path.join(base, '01 - SCIA', 'Relazione tecnica.pdf'), ['RELAZIONE TECNICA', 'Immobile censito al Catasto Fabbricati del Comune di Montevarchi al foglio 12, particella 345, subalterno 6.', 'Confina con foglio 12 particella 346.']);
  await pdf(path.join(base, '02 - Catasto', 'visura vecchia.pdf'), visura('01/02/2026', 12, 345, 6));
  await pdf(path.join(base, '02 - Catasto', 'DOC_99123.pdf'), visura('10/11/2026', 12, 345, 6));
  await pdf(path.join(base, '02 - Catasto', 'visura vicino.pdf'), visura('10/11/2026', 12, 345, 9));
  await pdf(path.join(base, '02 - Catasto', 'ricerca.pdf'), ['Visura per soggetto', 'Data: 10/11/2026', 'Dati della richiesta', 'Cognome: ROSSI Nome: MARIO', 'Foglio: 12 Particella: 345 Sub.: 6', 'Foglio: 30 Particella: 1 Sub.: 2']);
  await pdf(path.join(base, '02 - Catasto', 'planimetria.pdf'), ['Catasto dei Fabbricati', 'Planimetria di u.i.u. in Comune di Montevarchi', 'Dati della richiesta Foglio: 12 Particella: 345 Sub.: 6', 'Data: 05/11/2026']);

  const id = Number(Lavori.inserisci.run({ codice: 'V-1', titolo: 'Prova visure', descrizione: null, indirizzo: null, stato: 'In corso', cartella, data_inizio: null, data_fine: null, visibile: 1 }).lastInsertRowid);
  const lavoro = Lavori.perId.get(id);
  await pratiche.sincronizza(lavoro);
  db.prepare('UPDATE pratiche SET visibile = 1 WHERE lavoro_id = ?').run(id);
  const stato = await visure.aggiornaLavoro(lavoro);
  assert.deepStrictEqual(stato.unita, [{ f: '12', p: '345', s: '6' }]);

  const pr = db.prepare("SELECT * FROM pratiche WHERE lavoro_id = ? AND cartella = '02 - Catasto'").get(id);
  const file = pubblicati.annota(pr, await archivio.documentiPratica(lavoro, pr.cartella));
  const per = Object.fromEntries(file.map((f) => [f.nome, f]));
  assert.strictEqual(per['DOC_99123.pdf'].pubblicato, true, 'la visura più recente del sub 6');
  assert.match(per['DOC_99123.pdf'].notaVisura, /fg\. 12 part\. 345 sub\. 6\) del 10\/11\/2026/);
  assert.strictEqual(per['visura vecchia.pdf'].pubblicato, false);
  assert.match(per['visura vecchia.pdf'].notaVisura, /più recente/);
  assert.strictEqual(per['visura vicino.pdf'].pubblicato, false);
  assert.match(per['visura vicino.pdf'].notaVisura, /Altra unità \(fg\. 12 part\. 345 sub\. 9\)/);
  assert.ok(per['ricerca.pdf'].sensibile, 'visura per soggetto: sempre privata');
  assert.strictEqual(per['planimetria.pdf'].pubblicato, true);
  assert.strictEqual(pubblicati.visibile(lavoro, pr, 'DOC_99123.pdf'), true);
  assert.strictEqual(pubblicati.visibile(lavoro, pr, 'ricerca.pdf'), false);
  assert.strictEqual(pubblicati.pubblica(lavoro, pr, 'ricerca.pdf').ok, false);

  // Nascosta a mano: resta nascosta anche al giro successivo
  pubblicati.nascondi(pr, 'DOC_99123.pdf');
  await visure.aggiornaLavoro(lavoro);
  assert.strictEqual(pubblicati.visibile(lavoro, pr, 'DOC_99123.pdf'), false);

  // Unità scelta nella scheda immobile: prevale sui documenti
  Lavori.impostaScheda.run(JSON.stringify({ catasto: 'foglio 12 particella 345 sub 9' }), id);
  await visure.aggiornaLavoro(Lavori.perId.get(id));
  assert.strictEqual(pubblicati.visibile(lavoro, pr, 'visura vicino.pdf'), true);
});

test('documenti in disaccordo: nessuna pubblicazione e scelta richiesta', async () => {
  const cartella = 'Bianchi - Via Verdi';
  const base = path.join(process.env.ARCHIVIO_DIR, cartella);
  await pdf(path.join(base, 'SCIA', 'Relazione tecnica.pdf'), ['Immobile censito al foglio 5 particella 10 sub 1']);
  await pdf(path.join(base, 'SCIA', 'Modello SCIA.pdf'), ['Dati catastali: immobile identificato al foglio 5 particella 11 sub 3']);
  await pdf(path.join(base, 'Catasto', 'visura.pdf'), visura('01/10/2026', 5, 10, 1));
  const id = Number(Lavori.inserisci.run({ codice: 'V-2', titolo: 'Disaccordo', descrizione: null, indirizzo: null, stato: 'In corso', cartella, data_inizio: null, data_fine: null, visibile: 1 }).lastInsertRowid);
  const lavoro = Lavori.perId.get(id);
  await pratiche.sincronizza(lavoro);
  const stato = await visure.aggiornaLavoro(lavoro);
  assert.strictEqual(stato.conflitto.length, 2);
  assert.deepStrictEqual(stato.conflitto.map((c) => c.testo).sort(), ['fg. 5 part. 10 sub. 1', 'fg. 5 part. 11 sub. 3']);
  const pr = db.prepare("SELECT * FROM pratiche WHERE lavoro_id = ? AND cartella = 'Catasto'").get(id);
  db.prepare('UPDATE pratiche SET visibile = 1 WHERE id = ?').run(pr.id);
  assert.strictEqual(pubblicati.visibile(lavoro, pr, 'visura.pdf'), false);
});
