'use strict';
// Testi ricostruiti sulla struttura delle ricevute reali, con dati di fantasia.
const test = require('node:test');
const assert = require('node:assert');
const { riconosci, isoData } = require('../src/ricevute');

const casi = [
  ['URP Figline (servizi on line)', 'URP_RICEVUTA_1_2026000001.PDF',
    `Comune di Figline e Incisa Valdarno\nRICEVUTA SERVIZI ON LINE\nData - Ora Richiesta: 09-11-2026 - 15:24:55\nServizio Richiesto: INTEGRAZIONE ISTANZA\nIl protocollo abbinato alla richiesta è\n2026.47798\nConserva questa ricevuta`,
    { tipo: 'comune', stato: 'Presentata', data: '2026-11-09', protocollo: '2026.47798' }],
  ['Ricevuta Protocollo portale regionale', 'Ricevuta Protocollo - 1.pdf',
    `Ricevuta Protocollo\nCodice Amministrazione c_x000 Denominazione Comune di Esempio\nCodice istanza c_x000-1 Data invio 22/10/2026\nNumero protocollo 86105 Data protocollo 22/10/2026\nOggetto della pratica rossi mario - cila\nElenco allegati 1_Diritti_di_Segreteria(Ricevuta_pagamento)(0).pdf.p7m`,
    { tipo: 'comune', stato: 'Presentata', data: '2026-10-22', protocollo: '86105' }],
  ['Ricevuta di protocollazione', 'Ricevuta_2026_1.PDF',
    `Ricevuta di Protocollazione\nCAVRIGLIA, lì 16/10/2026\nOggetto: Ricevuta di presentazione di atto al protocollo comunale.\ndi un atto al protocollo comunale nella data odierna, alle ore 10:05 al numero 15932 avente come oggetto:`,
    { tipo: 'comune', stato: 'Presentata', data: '2026-10-16', protocollo: '15932' }],
  ['SUE telematica', 'document (1).pdf',
    `RICEVUTA Telematica PRESENTAZIONE ISTANZA\nUfficio ricevente: Trasmissione dell'istanza: 13/11/2026 N. Istanza Telematica: 66/2026/CDU Protocollo N. 24746 Data. 13/11/2026 Oggetto`,
    { tipo: 'comune', stato: 'Presentata', data: '2026-11-13', protocollo: '24746' }],
  ['SUAP attestazione', 'RICEVUTA_SCIA.pdf',
    `SPORTELLO UNICO ASSOCIATO\nATTESTAZIONE DI PRESENTAZIONE ------\nPRATICA N. 1137/2026\nHa presentato in data 27/10/2026 prot n. 13444\nSCIA/Comunicazione per: avvio`,
    { tipo: 'suap', stato: 'Presentata', data: '2026-10-27', protocollo: '13444' }],
  ['STAR avviso di ricevimento', 'XXXXXX00X00X000X-27102026-1605_RICEVUTA.pdf',
    `AVVISO DI RICEVIMENTO\nIDENTIFICATIVO PRATICA: XXXXXX00X00X000X-27102026-1605 Il SUAP del comune di REGGELLO Ha ricevuto in data 2026-10-27 16:13:25 la documentazione trasmessa.`,
    { tipo: 'suap', stato: 'Presentata', data: '2026-10-27', protocollo: 'XXXXXX00X00X000X-27102026-1605' }],
  ['DOCFA', '0000000243944926DGC.pdf',
    `DGC\nRiservato all'Ufficio Prospetto di liquidazione n: 4763/2026 Importo della liquidazione: Euro 70,00 Data: 07/07/2026 Pratica numero: PO0031772/2026\nOra: 18.59.47 Ricevuta di Avvenuta Denuncia di Variazione\nCatasto Fabbricati Pratica numero: PO0031772 Codice di Riscontro: 000A23P3P`,
    { tipo: 'docfa', stato: 'Completata', data: '2026-07-07', protocollo: 'PO0031772' }],
  ['RIAPE', 'RIAPE_20261112_1_1.pdf',
    `Data Ape:12/11/2026\nCon la presente si attesta che il tecnico ROSSI MARIO ha trasmesso telematicamente in data\n12/11/2026 L'APE id: 0001098570 corredato dal contributo`,
    { tipo: 'ape', stato: 'Completata', data: '2026-11-12', protocollo: '0001098570' }],
  ['APE attestato', 'ape_1_1.pdf',
    `ATTESTATO DI PRESTAZIONE ENERGETICA DEGLI EDIFICI\nCODICE IDENTIFICATIVO: 0001098570 VALIDO FINO: 12/11/2036\nData di emissione 12/11/2026 Firma`,
    { tipo: 'ape', stato: 'Completata', data: '2026-11-12', protocollo: '0001098570' }],
  ['ENEA CPID', 'CPID_151499-2026E-AAAA.pdf',
    `Comma 345A - Interventi sull'involucro\nCPID 151499-2026E-GLWSLKFKRVIYHMMP\nCPID annullato 151499-2026E-TGYKPJKBKVTSQNRI\nData chiusura scheda annullata 2026-05-21 16:44:40 CEST\nData chiusura 2026-05-21 16:58:16 CEST`,
    { tipo: 'enea', stato: 'Completata', data: '2026-05-21', protocollo: '151499-2026E-GLWSLKFKRVIYHMMP' }],
  ['ASL notifica preliminare', 'Notifica.pdf',
    `Mod. NCE.01\nNotifica Preliminare Cantiere Edile\nN° Notifica: 51013503604 – Data: 28/10/2026\nNumero Cantiere: 500295 Protocollo: AOO9203/0278937/2026`,
    { tipo: 'asl', stato: 'Presentata', data: '2026-10-28', protocollo: 'AOO9203/0278937/2026' }],
];

for (const [nome, file, testo, atteso] of casi) {
  test(`riconosce: ${nome}`, () => {
    const r = riconosci(testo, file);
    assert.ok(r, 'nessuna regola applicata');
    const { regola, ...dati } = r;
    assert.deepStrictEqual(dati, atteso);
  });
  test(`riconosce anche con testo compattato: ${nome}`, () => {
    // pdf-parse a volte unisce le righe senza spazi
    const r = riconosci(testo.replace(/\n/g, ''), file);
    assert.ok(r && r.tipo === atteso.tipo && r.protocollo === atteso.protocollo, JSON.stringify(r));
  });
}

test('ignora documenti che non sono ricevute', () => {
  assert.strictEqual(riconosci('Ricevuta di pagamento pagoPA importo 46,00 euro', 'pagopa-ricevuta.pdf'), null);
  assert.strictEqual(riconosci('RELAZIONE TECNICA La presente relazione...', 'Relazione.pdf'), null);
  assert.strictEqual(riconosci('', 'vuoto.pdf'), null);
});

test('conversione date', () => {
  assert.strictEqual(isoData('09-11-2026'), '2026-11-09');
  assert.strictEqual(isoData('1/2/2026'), '2026-02-01');
  assert.strictEqual(isoData('2026-05-21'), '2026-05-21');
  assert.strictEqual(isoData('32/01/2026'), null);
});
