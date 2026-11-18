'use strict';
/** Documenti in arrivo dalle imprese: link di caricamento, risposte email, antivirus, approvazione (dati inventati). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-arrivi-'));
process.env.ARCHIVIO_DIR = path.join(tmp, 'lavori');
process.env.DATI_DIR = path.join(tmp, 'app');
process.env.POSTA_CARTELLA = path.join(tmp, 'posta');
fs.mkdirSync(process.env.ARCHIVIO_DIR, { recursive: true });

const app = require('../src/server');
const auth = require('../src/auth');
const imprese = require('../src/imprese');
const arrivi = require('../src/arrivi');
const antivirus = require('../src/antivirus');
const postaIn = require('../src/posta-in-arrivo');
const { simpleParser } = require('mailparser');
const { Utenti } = require('../src/modelli');

const PW = 'PasswordSicura123';
let base; let server;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(30 * 1024, 1)]);
const nuova = (dati = {}) => Number(imprese.Q.inserisci.run({ ragione_sociale: 'Edile Arrivi srl', piva: null, sede: null, pec: null, email: null, telefono: null, autonomo: 0, nota: null, ...dati }).lastInsertRowid);

function browser() {
  let cookie = '';
  return {
    async go(p, opt = {}) {
      const r = await fetch(base + p, { redirect: 'manual', ...opt, headers: { ...(opt.headers || {}), cookie } });
      const sc = r.headers.getSetCookie();
      if (sc.length) cookie = sc.map((s) => s.split(';')[0]).join('; ');
      return { status: r.status, loc: r.headers.get('location'), testo: await r.text(), headers: r.headers };
    },
    async csrf(p) { return ((await this.go(p)).testo.match(/name="_csrf" value="([^"]+)"/) || [])[1] || ''; },
    async post(p, dati, da) { return this.go(p, { method: 'POST', body: new URLSearchParams({ ...dati, _csrf: await this.csrf(da) }) }); },
    async carica(p, files, da) {
      const fd = new FormData();
      fd.append('_csrf', await this.csrf(da));
      for (const [nome, buf] of files) fd.append('file', new Blob([buf]), nome);
      return this.go(p, { method: 'POST', body: fd });
    },
  };
}

/** Costruisce un'email come la riceverebbe la casella, con allegati. */
function email({ da, oggetto, allegati = [] }) {
  const b = 'XYZconfine';
  const parti = allegati.map(([nome, buf, tipo]) => [`--${b}`, `Content-Type: ${tipo}; name="${nome}"`, `Content-Disposition: attachment; filename="${nome}"`,
    'Content-Transfer-Encoding: base64', '', buf.toString('base64')].join('\r\n'));
  return [`From: ${da}`, 'To: info@esempio.it', `Subject: ${oggetto}`, 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${b}"`, '',
    `--${b}`, 'Content-Type: text/plain; charset=utf-8', '', 'Ecco il documento.', ...parti, `--${b}--`, ''].join('\r\n');
}

test.before(async () => {
  const h = await auth.hashPassword(PW);
  Utenti.inserisci.run('studio@esempio.it', h, 'Studio', null, 'admin');
  Utenti.inserisci.run('anna@esempio.it', h, 'Anna', null, 'cliente');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test('il promemoria contiene link e codice di riferimento firmato', async () => {
  const id = nuova({ email: 'a@edile.it' });
  const inviate = [];
  await imprese.inviaPromemoria(imprese.Q.perId.get(id), '', async (m) => { inviate.push(m); return true; });
  assert.match(inviate[0].oggetto, new RegExp(`\\[Rif\\. IMP-${id}-[0-9a-f]{6}\\]`));
  const link = inviate[0].testo.match(/\/carica\/([A-Za-z0-9_-]+)/);
  assert.ok(link);
  assert.strictEqual(arrivi.verificaLink(link[1]).impresa.id, id);
  assert.match(inviate[0].testo, /rispondete a questa email/);
  assert.strictEqual(arrivi.leggiRiferimento(inviate[0].oggetto), id);
  assert.strictEqual(arrivi.leggiRiferimento(`Re: [Rif. IMP-${id + 1}-000000]`), null);
  assert.strictEqual(arrivi.leggiRiferimento(inviate[0].oggetto.replace(`IMP-${id}-`, `IMP-${id + 1}-`)), null);
});

test('pagina di caricamento: link valido, file ammessi, falsi PDF e link inventati rifiutati', async () => {
  const id = nuova();
  const url = arrivi.creaLink(id).replace(/^https?:\/\/[^/]+/, '');
  const b = browser();
  assert.match((await b.go(url)).testo, /Edile Arrivi srl/);
  const r = await b.carica(url, [['DURC.pdf', PDF], ['finto.pdf', Buffer.from('MZ eseguibile camuffato da pdf')], ['virus.exe', Buffer.from('MZ')]], url);
  assert.strictEqual(r.status, 200);
  assert.match(r.testo, /il file è arrivato/);
  assert.match(r.testo, /finto\.pdf: il contenuto non corrisponde/);
  assert.match(r.testo, /virus\.exe: sono ammessi solo PDF, JPG e PNG/);
  const attesa = arrivi.inAttesa(id);
  assert.strictEqual(attesa.length, 1);
  assert.strictEqual(attesa[0].antivirus, 'non-controllato');
  assert.strictEqual((await b.go('/carica/' + 'x'.repeat(43))).status, 410);
  // senza il token CSRF della pagina non si carica niente, anche con il link giusto
  const fd = new FormData(); fd.append('file', new Blob([PDF]), 'altro.pdf');
  assert.strictEqual((await browser().go(url, { method: 'POST', body: fd })).status, 403);
  assert.strictEqual(arrivi.inAttesa(id).length, 1);
  // un link non dà accesso a nient'altro
  assert.notStrictEqual((await b.go(`/studio/imprese/${id}`)).status, 200);
});

test('antivirus: un file infetto viene scartato e non salvato', async () => {
  const id = nuova();
  const prima = antivirus.controlla;
  antivirus.controlla = async () => ({ esito: 'infetto', dettaglio: 'Eicar-Test-Signature' });
  try {
    const f = path.join(tmp, 'eicar.pdf'); fs.writeFileSync(f, PDF);
    const r = await arrivi.ricevi(id, { percorso: f, nome: 'eicar.pdf', dimensione: PDF.length }, { origine: 'link' });
    assert.deepStrictEqual([r.ok, r.infetto], [false, true]);
    assert.strictEqual(arrivi.inAttesa(id).length, 0);
  } finally { antivirus.controlla = prima; }
});

test('risposta email: presa solo dal mittente registrato e con codice valido; PEC letta dalla busta', async () => {
  const id = nuova({ email: 'ufficio@edile.it', pec: 'edile@pec.esempio.it' });
  const rif = arrivi.riferimento(id);
  const ok = await postaIn.elabora(await simpleParser(email({ da: 'Mario <Ufficio@Edile.it>', oggetto: `Re: Promemoria ${rif}`, allegati: [['DURC.pdf', PDF, 'application/pdf'], ['logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 'image/png']] })));
  assert.strictEqual(ok.esito, 'ricevuto');
  assert.deepStrictEqual(ok.salvati, ['DURC.pdf']); // il logo piccolo della firma non viene preso
  const estraneo = await postaIn.elabora(await simpleParser(email({ da: 'truffa@altro.it', oggetto: `Re: ${rif}`, allegati: [['DURC.pdf', PDF, 'application/pdf']] })));
  assert.strictEqual(estraneo.esito, 'mittente-diverso');
  const senzaCodice = await postaIn.elabora(await simpleParser(email({ da: 'ufficio@edile.it', oggetto: 'Re: documenti', allegati: [['DURC.pdf', PDF, 'application/pdf']] })));
  assert.strictEqual(senzaCodice.esito, 'ignorato');
  // PEC: il messaggio originale è dentro postacert.eml
  const interno = Buffer.from(email({ da: 'edile@pec.esempio.it', oggetto: `Re: ${rif}`, allegati: [['visura.png', PNG, 'image/png']] }));
  const pec = await postaIn.elabora(await simpleParser(email({ da: '"Per conto di: edile@pec.esempio.it" <posta-certificata@pec.esempio.it>', oggetto: `POSTA CERTIFICATA: Re: ${rif}`, allegati: [['postacert.eml', interno, 'message/rfc822']] })));
  assert.strictEqual(pec.esito, 'ricevuto');
  assert.deepStrictEqual(pec.salvati, ['visura.png']);
  assert.strictEqual(arrivi.inAttesa(id).length, 2);
});

test('lo studio controlla: registra con i dati corretti o scarta; il cliente non può', async () => {
  const id = nuova({ email: 'x@edile.it' });
  const f = path.join(tmp, 'd.pdf'); fs.writeFileSync(f, PDF);
  await arrivi.ricevi(id, { percorso: f, nome: 'DURC aprile.pdf', dimensione: PDF.length }, { origine: 'link' });
  await arrivi.ricevi(id, { percorso: f, nome: 'altro.pdf', dimensione: PDF.length }, { origine: 'link' });
  const [a1, a2] = arrivi.inAttesa(id);

  const cli = browser();
  await cli.post('/accedi', { email: 'anna@esempio.it', password: PW }, '/accedi');
  const c = await cli.csrf('/area');
  await cli.go(`/studio/imprese/${id}/arrivi/${a1.id}`, { method: 'POST', body: new URLSearchParams({ _csrf: c, azione: 'scarta' }) });
  assert.strictEqual(arrivi.inAttesa(id).length, 2);

  const st = browser();
  await st.post('/accedi', { email: 'studio@esempio.it', password: PW }, '/accedi');
  const pagina = (await st.go(`/studio/imprese/${id}`)).testo;
  assert.match(pagina, /da controllare \(2\)/);
  assert.match((await st.go('/studio')).testo, /Documenti arrivati dalle imprese/);
  assert.match((await st.go('/studio')).testo, /class="oggi"[^]*Da controllare o confermare/);
  // non controllato dall'antivirus: si scarica soltanto
  const file = await st.go(`/studio/imprese/${id}/arrivi/${a1.id}`);
  assert.match(file.headers.get('content-disposition'), /attachment/);
  await st.post(`/studio/imprese/${id}/arrivi/${a1.id}`, { azione: 'approva', tipo: 'durc', rilascio: '2026-11-01', scadenza: '2027-03-01', numero: 'INPS_123' }, `/studio/imprese/${id}`);
  const r = imprese.riepilogo(id);
  assert.strictEqual(r.durc.doc.scadenza, '2027-03-01');
  assert.ok(imprese.percorsoFile(r.durc.doc));
  await st.post(`/studio/imprese/${id}/arrivi/${a2.id}`, { azione: 'scarta' }, `/studio/imprese/${id}`);
  assert.strictEqual(arrivi.inAttesa(id).length, 0);
  assert.strictEqual(arrivi.percorso(arrivi.Q.perId.get(a2.id, id)), null);
});

test('modulo del lavoro: si vedono solo i collegati, si aggiunge dal menu con il ruolo e si toglie', async () => {
  const { Lavori } = require('../src/modelli');
  const h = await auth.hashPassword(PW);
  const bruno = Number(Utenti.inserisci.run('bruno@esempio.it', h, 'Bruno Bianchi', null, 'cliente').lastInsertRowid);
  const carla = Number(Utenti.inserisci.run('carla@esempio.it', h, 'Carla Verdi', null, 'cliente').lastInsertRowid);
  fs.mkdirSync(path.join(process.env.ARCHIVIO_DIR, 'M-1 Menu'), { recursive: true });
  const id = Number(Lavori.inserisci.run({ codice: 'M-1', titolo: 'Menu clienti', descrizione: null, indirizzo: null, stato: 'In corso', cartella: 'M-1 Menu', data_inizio: null, data_fine: null, visibile: 1 }).lastInsertRowid);
  Lavori.aggiungiConRuolo.run(id, bruno, 'proprietario', null);
  const st = browser();
  await st.post('/accedi', { email: 'studio@esempio.it', password: PW }, '/accedi');
  const pag = (await st.go(`/studio/lavori/${id}`)).testo;
  assert.match(pag, /class="da-fare-lavoro/);
  assert.match(pag, /<details class="carta sezione" id="aggiornamenti">/);
  const form = (await st.go(`/studio/lavori/${id}/modifica`)).testo;
  assert.match(form, /name="ruolo_\d+" value="proprietario" checked/);
  assert.match(form, /data-rimuovi aria-label="Rimuovi Bruno Bianchi dal lavoro"/);
  assert.ok(!/> Togli</.test(form));
  assert.match(form, /<option value="\d+" data-email="carla@esempio\.it">Carla Verdi/); // Carla solo nel menu
  assert.ok(!/Carla Verdi <small class="muto">carla/.test(form)); // ...e non tra i collegati
  const base = { codice: 'M-1', titolo: 'Menu clienti', stato: 'In corso', cartella: 'M-1 Menu', visibile: '1' };
  await st.post(`/studio/lavori/${id}`, { ...base, [`ruolo_${bruno}`]: 'proprietario', aggiungi_cliente: String(carla), aggiungi_ruolo: 'impresa' }, `/studio/lavori/${id}/modifica`);
  assert.deepStrictEqual(Lavori.clienti.all(id).map((c) => [c.nome, c.ruolo]), [['Bruno Bianchi', 'proprietario'], ['Carla Verdi', 'impresa']]);
  await st.post(`/studio/lavori/${id}`, { ...base, [`ruolo_${carla}`]: 'impresa' }, `/studio/lavori/${id}/modifica`);
  assert.deepStrictEqual(Lavori.clienti.all(id).map((c) => c.nome), ['Carla Verdi']);
});

test('telefono: link per chiamare e WhatsApp, promemoria via WhatsApp', async () => {
  const t = require('../src/telefono');
  assert.strictEqual(t.tel('339 123 4567'), 'tel:+393391234567');
  assert.strictEqual(t.whatsapp('+39 339-1234567', 'Ciao è'), 'https://wa.me/393391234567?text=Ciao%20%C3%A8');
  assert.strictEqual(t.cellulare('055 123456'), false);
  assert.strictEqual(t.tel('abc'), '');
  const id = nuova({ telefono: '333 0000000' });
  const st = browser();
  await st.post('/accedi', { email: 'studio@esempio.it', password: PW }, '/accedi');
  assert.match((await st.go(`/studio/imprese/${id}`)).testo, /Promemoria su WhatsApp/);
  const r = await st.post(`/studio/imprese/${id}/promemoria-whatsapp`, {}, `/studio/imprese/${id}`);
  assert.strictEqual(r.status, 303);
  assert.match(r.loc, /^https:\/\/wa\.me\/393330000000\?text=.*carica/);
  assert.ok(imprese.daSollecitare(id).every((v) => v.ultimo));
});

test('pagina del lavoro con visure in conflitto o unità dalla scheda: si apre senza errori', async () => {
  const visure = require('../src/visure');
  const vero = visure.stato;
  fs.mkdirSync(path.join(process.env.ARCHIVIO_DIR, 'V-1 Visure'), { recursive: true });
  const { Lavori } = require('../src/modelli');
  const id = Number(Lavori.inserisci.run({ codice: 'V-1', titolo: 'Visure', descrizione: null, indirizzo: null, stato: 'In corso', cartella: 'V-1 Visure', data_inizio: null, data_fine: null, visibile: 1 }).lastInsertRowid);
  const st = browser();
  await st.post('/accedi', { email: 'studio@esempio.it', password: PW }, '/accedi');
  try {
    visure.stato = () => ({ fonte: 'documenti', unita: [], soppresse: [], documenti: 2, conflitto: [{ nome: 'a.pdf', testo: 'fg. 1 part. 2 sub. 3' }, { nome: 'b.pdf', testo: 'fg. 1 part. 2 sub. 4' }] });
    const r = await st.go(`/studio/lavori/${id}`);
    assert.strictEqual(r.status, 200);
    assert.match(r.testo, new RegExp(`action="/studio/lavori/${id}/unita"`));
    visure.stato = () => ({ fonte: 'scheda immobile', unita: [{}], unitaTesto: 'fg. 1 part. 2 sub. 3', soppresse: [], documenti: 1, conflitto: null });
    assert.strictEqual((await st.go(`/studio/lavori/${id}`)).status, 200);
  } finally { visure.stato = vero; }
});
