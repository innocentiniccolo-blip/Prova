'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cruscotto-wa-'));
const drive = path.join(tmp, 'Studio Innocenti');
const cartellaWa = path.join(drive, '_WhatsApp da importare');
fs.mkdirSync(cartellaWa, { recursive: true });
process.env.DATI_DIR = path.join(tmp, 'dati');
process.env.DRIVE_DIR = drive;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.WHATSAPP_MIO_NOME;

const L = require('../src/whatsapp-lettore');
const wa = require('../src/whatsapp');
const { Clienti, Whatsapp } = require('../src/modelli');

test('legge esportazioni Android e iPhone, anche su più righe, saltando i messaggi di sistema', () => {
  const android = '20/11/26, 09:12 - I messaggi e le chiamate sono crittografati end-to-end.\n20/11/26, 09:13 - Sofia Forzini: Buongiorno\nseconda riga\n20/11/26, 21:05 - Niccolò Innocenti: Ciao: tutto ok';
  assert.deepStrictEqual(L.leggiChat(android), [
    { data: '2026-11-20 09:13', autore: 'Sofia Forzini', testo: 'Buongiorno\nseconda riga' },
    { data: '2026-11-20 21:05', autore: 'Niccolò Innocenti', testo: 'Ciao: tutto ok' },
  ]);
  const iphone = '‎[22/11/2026, 11:02:10] +39 347 555 1234: Salve\r\n[22/11/2026, 11:02:40] +39 347 555 1234: ‎immagine omessa';
  assert.deepStrictEqual(L.leggiChat(iphone).map((m) => [m.data, m.testo]), [['2026-11-22 11:02', 'Salve'], ['2026-11-22 11:02', 'immagine omessa']]);
  assert.strictEqual(L.nomeDaFile('Chat WhatsApp con Sofia Forzini (2).zip'), 'Sofia Forzini');
  assert.strictEqual(L.nomeDaFile('WhatsApp Chat with Mario.txt'), 'Mario');
  assert.strictEqual(L.telefonoDaNome('+39 347 555 1234'), '393475551234');
  assert.strictEqual(L.telefonoDaNome('Sofia'), null);
});

test('collega le chat ai clienti per nome (anche invertito) o per numero', () => {
  Clienti.inserisci.run({ nome: 'Forzini Sofia', telefono: '', email: '', note: '' });
  Clienti.inserisci.run({ nome: 'Mattia Biffoli', telefono: '347 555 1234', email: '', note: '' });
  assert.strictEqual(wa.trovaCliente('Sofia Forzini', null).nome, 'Forzini Sofia');
  assert.strictEqual(wa.trovaCliente('+39 347 555 1234', '393475551234').nome, 'Mattia Biffoli');
  assert.strictEqual(wa.trovaCliente('Idraulico Paolo', null), null);
});

test('importa la cartella: solo messaggi nuovi, file spostati, stato da rispondere', async () => {
  const chat1 = '20/11/26, 09:13 - Sofia Forzini: Buongiorno, novità?\n20/11/26, 09:40 - Niccolò Innocenti: Non ancora\n';
  fs.writeFileSync(path.join(cartellaWa, 'Chat WhatsApp con Sofia Forzini.txt'), chat1);
  let r = await wa.importa();
  assert.strictEqual(r.file, 1);
  assert.strictEqual(r.nuovi, 2);
  assert.ok(!fs.existsSync(path.join(cartellaWa, 'Chat WhatsApp con Sofia Forzini.txt')));
  assert.ok(fs.readdirSync(path.join(cartellaWa, 'Importate')).length === 1);
  let c = Whatsapp.perNome.get('Sofia Forzini');
  assert.strictEqual(c.stato, 'gestita'); // l'ultimo messaggio è mio
  assert.ok(c.cliente_id);
  assert.strictEqual(Whatsapp.messaggi.all(c.id, 10).filter((m) => m.mio).length, 1); // "io" riconosciuto da solo

  // La sera dopo: chat esportata di nuovo per intero, con un messaggio nuovo del cliente (e un "ok" ripetuto)
  fs.writeFileSync(path.join(cartellaWa, 'Chat WhatsApp con Sofia Forzini.txt'), `${chat1}23/11/26, 17:55 - Sofia Forzini: ok\n23/11/26, 17:55 - Sofia Forzini: ok\n23/11/26, 17:56 - Sofia Forzini: Si può iniziare lunedì?\n`);
  r = await wa.importa();
  assert.strictEqual(r.nuovi, 3);
  c = Whatsapp.perId.get(c.id);
  assert.strictEqual(c.n_messaggi, 5);
  assert.strictEqual(c.stato, 'da_rispondere');
  assert.strictEqual(fs.readdirSync(path.join(cartellaWa, 'Importate', fs.readdirSync(path.join(cartellaWa, 'Importate'))[0])).length, 2); // nessuna sovrascrittura
});

test('zip con media e file non validi', async () => {
  const AdmZip = require('adm-zip');
  const z = new AdmZip();
  z.addFile('_chat.txt', Buffer.from('[22/11/26, 11:02:10] +39 347 555 1234: Mi serve un APE'));
  z.addFile('IMG-001.jpg', Buffer.from('jpg'));
  z.writeZip(path.join(cartellaWa, 'Chat WhatsApp con +39 347 555 1234.zip'));
  fs.writeFileSync(path.join(cartellaWa, 'lista spesa.txt'), 'pane, latte');
  const r = await wa.importa();
  assert.strictEqual(r.file, 1);
  assert.strictEqual(r.errori.length, 1);
  assert.match(r.errori[0], /lista spesa\.txt/);
  assert.ok(fs.existsSync(path.join(cartellaWa, 'lista spesa.txt'))); // i file non riconosciuti restano lì
  const c = Whatsapp.perNome.get('+39 347 555 1234');
  assert.strictEqual(Clienti.perId.get(c.cliente_id).nome, 'Mattia Biffoli');
  assert.strictEqual(c.stato, 'da_rispondere');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
