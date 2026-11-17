'use strict';
/**
 * Versione di prova da usare sul proprio PC: prepara un archivio di esempio con dati inventati,
 * crea gli account di prova e avvia l'area clienti su http://localhost:3000.
 * I dati stanno nella cartella "prova" accanto al programma; per ripartire da zero basta cancellarla.
 */
const fs = require('node:fs');
const path = require('node:path');

const radice = path.join(__dirname, '..', 'prova');
Object.assign(process.env, {
  DATI_DIR: path.join(radice, 'dati'),
  ARCHIVIO_DIR: path.join(radice, 'Archivio lavori (prova)'),
  POSTA_CARTELLA: path.join(radice, 'Email inviate (prova)'),
  SOLO_AREA: 'true',
  AUTOMAZIONI_MINUTI: process.env.AUTOMAZIONI_MINUTI || '1',
  PORT: process.env.PORT || '3000',
});
const PRIMA_VOLTA = !fs.existsSync(path.join(process.env.DATI_DIR, 'studio.sqlite'));

const ACCOUNT = {
  studio: { email: 'studio@prova.it', password: 'StudioProva2026' },
  cliente: { email: 'mario.rossi@prova.it', password: 'ClienteProva2026' },
  cliente2: { email: 'laura.bianchi@prova.it', password: 'ClienteProva2026' },
};

// PDF minimo con testo leggibile (anche dalla lettura automatica delle ricevute)
function pdf(righe) {
  const testo = righe.map((r, i) => `BT /F1 12 Tf 50 ${780 - i * 18} Td (${String(r).replace(/[()\\]/g, '')}) Tj ET`).join('\n');
  const ogg = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(testo, 'latin1')} >>\nstream\n${testo}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const pos = [];
  ogg.forEach((o, i) => { pos.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${ogg.length + 1}\n0000000000 65535 f \n${pos.map((p) => `${String(p).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${ogg.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function scrivi(rel, righe) {
  const abs = path.join(process.env.ARCHIVIO_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, /\.pdf$/i.test(rel) ? pdf(righe || ['DOCUMENTO DI PROVA', path.basename(rel), '', 'Contenuto inventato per la prova dell\'area clienti.']) : `File di prova: ${path.basename(rel)}`);
}

function preparaArchivio() {
  const L1 = '2026-001 Ristrutturazione Rossi - Via Roma 12';
  for (const d of ['01 - Accesso atti/Presentazione', '02 - Rilievo', '03 - CILA/Presentazione', '04 - Catasto', '05 - Fine lavori', '06 - Preventivi', '07 - Contabilita']) {
    fs.mkdirSync(path.join(process.env.ARCHIVIO_DIR, L1, d), { recursive: true });
  }
  scrivi(`${L1}/01 - Accesso atti/Presentazione/Esito accesso atti.pdf`);
  scrivi(`${L1}/01 - Accesso atti/Presentazione/Licenza edilizia 1972.pdf`);
  scrivi(`${L1}/01 - Accesso atti/Richiesta accesso atti.pdf`);
  scrivi(`${L1}/02 - Rilievo/Rilievo stato attuale.dwg`);
  scrivi(`${L1}/03 - CILA/Presentazione/Tav.01 - Stato attuale.pdf`);
  scrivi(`${L1}/03 - CILA/Presentazione/Tav.02 - Stato di progetto.pdf`);
  scrivi(`${L1}/03 - CILA/Presentazione/Tav.03 - Sovrapposto.pdf`);
  scrivi(`${L1}/03 - CILA/Presentazione/Relazione tecnica.pdf`);
  scrivi(`${L1}/03 - CILA/Presentazione/Relazione tecnica.pdf.p7m`);
  scrivi(`${L1}/03 - CILA/Presentazione/Carta identita Mario Rossi.pdf`);
  scrivi(`${L1}/03 - CILA/Presentazione/Procura speciale.pdf`);
  scrivi(`${L1}/03 - CILA/Bozza relazione.pdf`);
  scrivi(`${L1}/03 - CILA/Ricevuta Protocollo.pdf`, ['Ricevuta di Protocollazione', 'CASTELFRANCO PIANDISCO, li 10/11/2026',
    'Oggetto: Ricevuta di presentazione di atto al protocollo comunale.',
    'di un atto al protocollo comunale nella data odierna, alle ore 09:12 al numero 18405 avente come oggetto:', 'CILA - ROSSI MARIO - VIA ROMA 12']);
  scrivi(`${L1}/04 - Catasto/0000000243944926DGC.pdf`, ['DGC', 'Data: 13/11/2026 Ora: 18.59.47 Ricevuta di Avvenuta Denuncia di Variazione',
    'Catasto Fabbricati Pratica numero: AR0031772 Codice di Riscontro: 000A23P3P']);
  scrivi(`${L1}/06 - Preventivi/Preventivo impresa.pdf`);
  scrivi(`${L1}/07 - Deposito sismico/Attestazione deposito.pdf`, ['Settore SISMICA', 'Data Avviso 08/07/2026', 'Attestazione di deposito progetto', 'Progetto n. 100200', 'e stato attribuito n. protocollo 20260000001 e n.progetto 100200']);
  scrivi(`${L1}/07 - Deposito sismico/fine_lavori_100200.pdf`, ['Settore SISMICA', 'Dichiarazione di Regolare Esecuzione, ai sensi degli articoli 65 e 67 del D.P.R. 380/2001', 'Dati Riepilogativi: Deposito n. 100200 del 08/07/2026', 'Data Invio D.R.E 30/07/2026', 'AOOGRT/SISMICA/20260011111/N.060.100 del 30/07/2026']);
  scrivi(`${L1}/03 - CILA/Integrazione/Ricevuta integrazione.pdf`, ['Ricevuta di Protocollazione', 'CASTELFRANCO PIANDISCO, li 14/11/2026', 'alle ore 10:02 al numero 11391 avente come oggetto:', 'integrazione documentale']);

  const relazione = ['STUDIO TECNICO GEOM. NICCOLO INNOCENTI - Viale Marconi 38 - Pian di Sco', 'RELAZIONE TECNICA DI CONFORMITA URBANISTICA E CATASTALE',
    'Committente: Mario Rossi, residente in Via Verdi n. 5, Montevarchi', 'Immobile sito in Castelfranco Piandisco, Via Roma n. 12',
    "L'unita immobiliare e censita al Catasto Fabbricati del Comune di Castelfranco Piandisco al foglio 12,", 'particella 345, subalterno 6,',
    'categoria A/2, classe 3, consistenza 6,5 vani, rendita Euro 520,00.', 'PRECEDENTI EDILIZI',
    'Licenza edilizia n. 45 del 12/03/1972', 'Concessione in sanatoria n. 112 del 05/06/1990', 'CILA n. 230 del 10/11/2026',
    "DESCRIZIONE DELL'IMMOBILE", 'Appartamento al piano primo di un fabbricato bifamiliare, composto da ingresso, soggiorno, cucina,',
    'due camere e bagno, con resede esclusivo e garage al piano terra.', 'CONCLUSIONI',
    'Non sono state rilevate difformita: lo stato attuale risulta conforme ai titoli edilizi sopra elencati.'];
  scrivi(`${L1}/02 - Relazione di conformita/Relazione tecnica di conformita.pdf`, relazione);
  scrivi(`${L1}/02 - Relazione di conformita/Relazione tecnica di conformita.pdf.p7m`, relazione);
  scrivi(`${L1}/05 - APE/APE Via Roma 12.pdf`, ['ATTESTATO DI PRESTAZIONE ENERGETICA DEGLI EDIFICI', 'CODICE IDENTIFICATIVO: 2026-AR-001234',
    'VALIDO FINO AL: 15/10/2036', 'CLASSE ENERGETICA E', 'EPgl,nren 145,32 kWh/m2 anno']);


  const L2 = '2026-002 SCIA Bianchi - Montevarchi';
  scrivi(`${L2}/01 - SCIA/Presentazione/Tavola unica.pdf`);
  scrivi(`${L2}/01 - SCIA/Presentazione/Relazione asseverata.pdf`);
  scrivi(`${L2}/01 - SCIA/Ricevuta_Protocollo.pdf`, ['Ricevuta di Protocollazione', 'MONTEVARCHI, li 02/10/2026',
    'di un atto al protocollo comunale nella data odierna, alle ore 10:00 al numero 31122 avente come oggetto:', 'SCIA EDILIZIA - BIANCHI LAURA']);
  scrivi(`${L2}/01 - SCIA/Integrazione 1/Ricevuta_2026_32010.pdf`, ['Ricevuta di Protocollazione', 'MONTEVARCHI, li 21/10/2026',
    'alle ore 11:30 al numero 32010 avente come oggetto:', 'INTEGRAZIONE SCIA PROT. 31122']);
  scrivi(`${L2}/02 - APE/ape_0001234567.pdf`, ['ATTESTATO DI PRESTAZIONE ENERGETICA DEGLI EDIFICI', 'CODICE IDENTIFICATIVO: 0001234567 VALIDO FINO: 05/11/2036', 'Data di emissione 05/11/2026']);

  // Un lavoro nuovo con la scheda cliente: l'app lo propone da confermare
  const L3 = '2026-003 Verdi Giulia - Successione e voltura';
  fs.mkdirSync(path.join(process.env.ARCHIVIO_DIR, L3, '01 - Successione'), { recursive: true });
  fs.writeFileSync(path.join(process.env.ARCHIVIO_DIR, L3, '_cliente.txt'), 'nome: Giulia Verdi\r\nemail: giulia.verdi@prova.it\r\ntelefono: 333 0000000\r\n');
}

async function preparaDati() {
  const auth = require('../src/auth');
  const { Utenti, Lavori, Aggiornamenti, db } = require('../src/modelli');
  const pratiche = require('../src/pratiche');
  const pubblicati = require('../src/pubblicati');
  const imprese = require('../src/imprese');
  const richieste = require('../src/richieste');
  const h = (pw) => auth.hashPassword(pw);
  Utenti.inserisci.run(ACCOUNT.studio.email, await h(ACCOUNT.studio.password), 'Geom. Niccolò Innocenti (prova)', null, 'admin');
  const rossi = Number(Utenti.inserisci.run(ACCOUNT.cliente.email, await h(ACCOUNT.cliente.password), 'Mario Rossi', '333 1234567', 'cliente').lastInsertRowid);
  const bianchi = Number(Utenti.inserisci.run(ACCOUNT.cliente2.email, await h(ACCOUNT.cliente2.password), 'Laura Bianchi', null, 'cliente').lastInsertRowid);
  const nuovo = (codice, titolo, cartella, extra = {}) => Number(Lavori.inserisci.run({
    codice, titolo, descrizione: null, indirizzo: null, stato: 'In corso', cartella, data_inizio: null, data_fine: null, visibile: 1, ...extra,
  }).lastInsertRowid);
  const l1 = nuovo('2026-001', 'Ristrutturazione appartamento Rossi', '2026-001 Ristrutturazione Rossi - Via Roma 12',
    { indirizzo: 'Via Roma 12, Castelfranco Piandiscò (AR)', descrizione: 'Ristrutturazione interna con rifacimento di bagno e impianti, aggiornamento catastale a fine lavori.', data_inizio: '2026-09-15', data_fine: '2027-01-31' });
  const l2 = nuovo('2026-002', 'SCIA e APE Bianchi', '2026-002 SCIA Bianchi - Montevarchi', { indirizzo: 'Montevarchi (AR)' });
  Lavori.aggiungiCliente.run(l1, rossi);
  Lavori.aggiungiCliente.run(l2, bianchi);

  const imposta = (lavoro, cartella, campi) => {
    const p = db.prepare('SELECT * FROM pratiche WHERE lavoro_id = ? AND cartella = ?').get(lavoro, cartella);
    db.prepare('UPDATE pratiche SET stato = COALESCE(?, stato), data = ?, protocollo = ?, nota = ?, visibile = ? WHERE id = ?')
      .run(campi.stato || null, campi.data || null, campi.protocollo || null, campi.nota || null, campi.visibile ? 1 : 0, p.id);
  };
  await pratiche.sincronizza(Lavori.perId.get(l1));
  await pratiche.sincronizza(Lavori.perId.get(l2));
  imposta(l1, '01 - Accesso atti', { stato: 'Completata', data: '2026-09-02', protocollo: '2026.31220', visibile: true });
  imposta(l1, '02 - Rilievo', { stato: 'Completata', data: '2026-09-10', visibile: true });
  imposta(l1, '03 - CILA', { stato: 'In corso', nota: 'Pratica pronta: la presento in Comune nei prossimi giorni.', visibile: true });
  imposta(l1, '04 - Catasto', { stato: 'Da fare', nota: 'Si presenta a fine lavori.', visibile: true });
  imposta(l1, '05 - Fine lavori', { stato: 'Da fare', visibile: false });
  imposta(l2, '01 - SCIA', { visibile: true });
  imposta(l2, '02 - APE', { visibile: true });
  Aggiornamenti.inserisci.run(l1, 'Sopralluogo con l\'impresa: i lavori procedono secondo il programma.');
  // Un documento pubblicato a mano, fuori dalla cartella Presentazione
  pubblicati.pubblica(Lavori.perId.get(l1), db.prepare("SELECT * FROM pratiche WHERE lavoro_id = ? AND cartella = '02 - Rilievo'").get(l1), 'Rilievo stato attuale.dwg');

  // Sicurezza cantiere sul lavoro Rossi
  imprese.Q.impostaSicurezza.run(1, l1);
  const tmp = path.join(radice, 'tmp-prova.pdf');
  fs.writeFileSync(tmp, pdf(['DOCUMENTO DI PROVA', 'Visura / DURC inventati per la prova']));
  const giorni = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const impresa = async (dati, ruolo, docs) => {
    const id = Number(imprese.Q.inserisci.run({ piva: null, sede: null, pec: null, telefono: null, autonomo: 0, nota: null, ...dati }).lastInsertRowid);
    imprese.Q.collega.run(l1, id, ruolo, 1);
    for (const d of docs) await imprese.salvaDocumento(id, d, d.file === false ? null : tmp, `${d.tipo}.pdf`);
  };
  await impresa({ ragione_sociale: 'Edil Valdarno S.r.l. (prova)', piva: '01234567890' }, 'Impresa affidataria',
    [{ tipo: 'visura', rilascio: giorni(-40) }, { tipo: 'durc', rilascio: giorni(-30), numero: 'INPS_00000001' }, { tipo: 'patente', numero: 'PAC-PROVA-1', crediti: 30, file: false }]);
  await impresa({ ragione_sociale: 'Termoidraulica Bianchi (prova)' }, 'Impianto idraulico',
    [{ tipo: 'visura', rilascio: giorni(-60) }, { tipo: 'durc', rilascio: giorni(-112) }, { tipo: 'patente', numero: 'PAC-PROVA-2', crediti: 30, file: false }]);
  await impresa({ ragione_sociale: 'Elettro Service di Neri Paolo (prova)', autonomo: 1 }, 'Impianto elettrico',
    [{ tipo: 'visura', rilascio: giorni(-20) }, { tipo: 'durc', rilascio: giorni(-10) }]);
  await imprese.salvaVerbale(l1, { data: '2026-09-15', tipo: 'Verbale di consegna lavori', note: 'Consegna del cantiere alle imprese.', visibile: 1 }, tmp, 'verbale.pdf');
  await imprese.salvaVerbale(l1, { data: '2026-11-06', tipo: 'Sopralluogo del CSE', note: 'Ponteggio conforme.', visibile: 1 }, tmp, 'verbale.pdf');
  fs.rmSync(tmp, { force: true });

  // Documenti richiesti al cliente
  richieste.crea(Lavori.perId.get(l1), "Carta d'identità e codice fiscale", 'Fronte e retro.');
  richieste.crea(Lavori.perId.get(l1), 'Atto di provenienza', "L'atto di acquisto dell'appartamento.");
}

(async () => {
  try {
    if (PRIMA_VOLTA) {
      fs.mkdirSync(process.env.DATI_DIR, { recursive: true });
      preparaArchivio();
    }
    const app = require('../src/server');
    if (PRIMA_VOLTA) await preparaDati();
    require('../src/automazioni').avvia();
    require('../src/pulizia').avvia();
    process.on('unhandledRejection', (e) => console.error('Errore non gestito:', e));
    const porta = Number(process.env.PORT);
    const server = require('node:http').createServer(app);
    server.listen(porta, '127.0.0.1', () => {
      console.log('');
      console.log('  ================================================================');
      console.log('   AREA CLIENTI - VERSIONE DI PROVA (solo su questo computer)');
      console.log('  ================================================================');
      console.log(`   Apri nel browser:  http://127.0.0.1:${porta}`);
      console.log('');
      console.log(`   Pannello dello studio:  ${ACCOUNT.studio.email}   password: ${ACCOUNT.studio.password}`);
      console.log(`   Cliente Mario Rossi:    ${ACCOUNT.cliente.email}   password: ${ACCOUNT.cliente.password}`);
      console.log(`   Cliente Laura Bianchi:  ${ACCOUNT.cliente2.email}  password: ${ACCOUNT.cliente2.password}`);
      console.log('');
      console.log(`   Archivio di prova:  ${process.env.ARCHIVIO_DIR}`);
      console.log(`   Email (non spedite): ${process.env.POSTA_CARTELLA}`);
      console.log('');
      console.log('   Per chiudere: chiudi questa finestra.');
      console.log('  ================================================================');
    }).on('error', (e) => {
      console.error(e.code === 'EADDRINUSE' ? `\n  La porta ${porta} è già occupata: forse la prova è già aperta in un'altra finestra.\n` : e);
    });
  } catch (e) {
    console.error('\n  Avvio non riuscito:', e);
  }
})();
