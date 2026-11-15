'use strict';
/** Imprese lette dalla cartella "Sicurezza" del lavoro (dati inventati, formati dei documenti reali). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sicdrive-'));
process.env.ARCHIVIO_DIR = path.join(tmp, 'lavori');
process.env.DATI_DIR = path.join(tmp, 'app');
const { leggiDocumento, importaLavoro } = require('../src/sicurezzaDrive');
const imprese = require('../src/imprese');
const { Lavori } = require('../src/modelli');

const DURC = `Durc On Line Numero Protocollo INPS\\_12345678 Data richiesta 06/07/2026 Scadenza validità 03/11/2026
Denominazione/ragione sociale MARIO ROSSI Codice fiscale RSSMRA80A01A000A Sede legale VIA ROMA 1 MONTEVARCHI AR 52025`;
const VISURA = `Camera di Commercio DATI ANAGRAFICI ... Documento n . T 1 estratto dal Registro Imprese in data 19/10/2026
VISURA ORDINARIA DELL'IMPRESA ROSSI COSTRUZIONI DI MARIO ROSSI Registro Imprese Archivio ufficiale
1 Sede Indirizzo Sede MONTEVARCHI (AR) VIA ROMA 1 CAP 52025 Domicilio digitale/PEC rossi@pec.it Partita IVA 01234567890 Numero repertorio`;
const PATENTE1 = `Ispettorato del Lavoro: Servizi Online e Patente a Crediti Ragione sociale/Nome e cognome lav. autonomo ROSSI COSTRUZIONI
Codice fiscale RSSMRA80A01A000A Numero patente PAC-AB-123-CD Stato patente Attiva Punteggio iniziale 30 Data di rilascio 24/10/2024 Punteggio attuale 32`;
const PATENTE2 = `Ricevuta di rilascio della Patente a Crediti Ragione Sociale: BIANCHI LUCA Codice Fiscale: BNCLCU90A01A000A
Codice Patente Associata: PAC-SI-736-HE Data rilascio Patente Associata: 11/10/2024`;

test('DURC: date, scadenza, protocollo e nome', () => {
  const d = leggiDocumento('durc 09-07-26.pdf', DURC);
  assert.strictEqual(d.tipo, 'durc');
  assert.strictEqual(d.rilascio, '2026-07-06');
  assert.strictEqual(d.scadenza, '2026-11-03');
  assert.strictEqual(d.numero, 'INPS_12345678');
  assert.strictEqual(d.anagrafica.nome, 'MARIO ROSSI');
});

test('visura: data di estrazione, denominazione, P.IVA, PEC e sede', () => {
  const v = leggiDocumento('Visura (19 10 2026).pdf', VISURA);
  assert.strictEqual(v.tipo, 'visura');
  assert.strictEqual(v.rilascio, '2026-10-19');
  assert.strictEqual(v.anagrafica.nome, 'ROSSI COSTRUZIONI DI MARIO ROSSI');
  assert.strictEqual(v.anagrafica.piva, '01234567890');
  assert.strictEqual(v.anagrafica.pec, 'rossi@pec.it');
  assert.match(v.anagrafica.sede, /VIA ROMA 1, 52025 MONTEVARCHI/);
});

test('patente a crediti: numero, crediti e rilascio (due formati)', () => {
  const p1 = leggiDocumento('Ispettorato del Lavoro_ Servizi Online e Patente a Crediti.pdf', PATENTE1);
  assert.deepStrictEqual([p1.tipo, p1.numero, p1.crediti, p1.rilascio], ['patente', 'PAC-AB-123-CD', 32, '2024-10-24']);
  const p2 = leggiDocumento('Patente a punti.pdf', PATENTE2);
  assert.deepStrictEqual([p2.tipo, p2.numero, p2.crediti, p2.rilascio], ['patente', 'PAC-SI-736-HE', undefined, '2024-10-11']);
});

test('altri PDF restano "altro" con il nome come descrizione', () => {
  const a = leggiDocumento('certificato-INAIL_valido fino al 09.02.2027.pdf', 'INAIL certificato');
  assert.strictEqual(a.tipo, 'altro');
  assert.strictEqual(a.descrizione, 'certificato-INAIL_valido fino al 09.02.2027');
});

test('import dalla cartella Sicurezza: crea imprese, collega al cantiere, attiva la sezione, non duplica', async () => {
  const cart = '2026-009 Prova';
  const dir = path.join(process.env.ARCHIVIO_DIR, cart, '007-Sicurezza', 'Rossi');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(process.env.ARCHIVIO_DIR, cart, '007-Sicurezza', 'Vuota'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'non leggibile.pdf'), 'non è un pdf');
  const id = Number(Lavori.inserisci.run({ codice: '2026-009', titolo: 'Prova', descrizione: null, indirizzo: null, stato: 'In corso', cartella: cart, data_inizio: null, data_fine: null, visibile: 1 }).lastInsertRowid);
  assert.strictEqual(await importaLavoro(Lavori.perId.get(id)), 1);
  const imp = imprese.impreseDelLavoro(id);
  assert.strictEqual(imp.length, 1);
  assert.strictEqual(imp[0].ragione_sociale, 'Rossi');
  assert.strictEqual(Lavori.perId.get(id).sicurezza, 1);
  assert.strictEqual(await importaLavoro(Lavori.perId.get(id)), 0, 'secondo giro: nessun duplicato');
});
