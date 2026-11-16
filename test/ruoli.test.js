'use strict';
/** Ruoli sul lavoro: proprietario, agenzia, impresa vedono solo le pratiche spuntate per loro. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ruoli-'));
process.env.ARCHIVIO_DIR = path.join(tmp, 'lavori');
process.env.DATI_DIR = path.join(tmp, 'app');
const pratiche = require('../src/pratiche');
const ruoli = require('../src/ruoli');
const { Lavori, Pratiche } = require('../src/modelli');

test('pratiche consigliate per l\'agenzia', () => {
  for (const n of ['01 - Accesso atti', 'Relazione tecnica di conformità', 'APE', 'Sanatoria', 'CILA tardiva', 'Catasto', 'Regolarizzazione']) assert.ok(ruoli.consigliataAgenzia(n), n);
  for (const n of ['Nota tecnica', 'Contabilità', 'Preventivi', '007-Sicurezza']) assert.ok(!ruoli.consigliataAgenzia(n), n);
});

test('ogni ruolo vede solo le sue pratiche', async () => {
  const cart = '2026-050 Vendita';
  for (const d of ['Accesso atti', 'APE', 'Nota tecnica']) fs.mkdirSync(path.join(process.env.ARCHIVIO_DIR, cart, d), { recursive: true });
  const id = Number(Lavori.inserisci.run({ codice: '2026-050', titolo: 'Vendita', descrizione: null, indirizzo: null, stato: 'In corso', cartella: cart, data_inizio: null, data_fine: null, visibile: 1 }).lastInsertRowid);
  const l = Lavori.perId.get(id);
  const el = await pratiche.sincronizza(l);
  const per = Object.fromEntries(el.map((p) => [p.cartella, p.id]));
  Pratiche.visibilitaRuoli.run(1, 1, 0, per['Accesso atti'], id); // proprietario + agenzia
  Pratiche.visibilitaRuoli.run(0, 1, 0, per.APE, id);             // solo agenzia
  Pratiche.visibilitaRuoli.run(1, 0, 0, per['Nota tecnica'], id); // solo proprietario
  const vede = async (r) => (await pratiche.conDocumenti(l, { soloVisibili: true, ruolo: r })).map((p) => p.cartella).sort();
  assert.deepStrictEqual(await vede('proprietario'), ['Accesso atti', 'Nota tecnica']);
  assert.deepStrictEqual(await vede('agenzia'), ['APE', 'Accesso atti']);
  assert.deepStrictEqual(await vede('impresa'), []);
  assert.deepStrictEqual(await vede('sconosciuto'), ['Accesso atti', 'Nota tecnica'], 'ruolo non valido = proprietario');
});
