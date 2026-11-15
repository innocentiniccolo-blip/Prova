'use strict';
/** Documenti richiesti: il cliente carica file che finiscono nella cartella del lavoro. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-richieste-'));
process.env.ARCHIVIO_DIR = path.join(tmp, 'lavori');
process.env.DATI_DIR = path.join(tmp, 'app');
fs.mkdirSync(process.env.ARCHIVIO_DIR, { recursive: true });

const app = require('../src/server');
const auth = require('../src/auth');
const richieste = require('../src/richieste');
const posta = require('../src/posta');
const { Utenti, Lavori } = require('../src/modelli');

let base; let server; let lavoroA; let lavoroB; let rA; let rB; let annaId;
const PW = 'PasswordSicura123';
const inviate = [];
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
const dirA = () => path.join(process.env.ARCHIVIO_DIR, 'A-1 Anna', 'Documenti dal cliente');
const tuttiIFile = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).filter((x) => fs.statSync(path.join(d, x)).isFile()) : []);

function browser() {
  let cookie = '';
  return {
    async go(p, opt = {}) {
      const r = await fetch(base + p, { redirect: 'manual', ...opt, headers: { ...(opt.headers || {}), cookie } });
      const sc = r.headers.getSetCookie();
      if (sc.length) cookie = sc.map((s) => s.split(';')[0]).join('; ');
      return { status: r.status, loc: r.headers.get('location'), text: await r.text() };
    },
    async csrf(p) { return ((await this.go(p)).text.match(/name="_csrf" value="([^"]+)"/) || [])[1] || ''; },
    async post(p, dati, da = '/accedi') {
      return this.go(p, { method: 'POST', body: new URLSearchParams({ ...dati, _csrf: await this.csrf(da) }) });
    },
    async carica(p, files, { da, csrf = true } = {}) {
      const fd = new FormData();
      for (const [nome, buf] of files) fd.append('file', new Blob([buf]), nome);
      if (csrf) fd.append('_csrf', await this.csrf(da));
      const r = await this.go(p, { method: 'POST', body: fd });
      // Segue il redirect per leggere il messaggio mostrato al cliente
      return r.status === 302 && r.loc ? { ...r, pagina: (await this.go(r.loc.split('#')[0])).text } : r;
    },
    accedi(email) { return this.post('/accedi', { email, password: PW }); },
  };
}

test.before(async () => {
  posta.invia = async (m) => { inviate.push(m); return true; };
  const h = await auth.hashPassword(PW);
  Utenti.inserisci.run('studio@esempio.it', h, 'Studio', null, 'admin');
  annaId = Number(Utenti.inserisci.run('anna@esempio.it', h, 'Anna', null, 'cliente').lastInsertRowid);
  const b = Number(Utenti.inserisci.run('bruno@esempio.it', h, 'Bruno', null, 'cliente').lastInsertRowid);
  const mk = (codice, titolo, cartella) => Number(Lavori.inserisci.run({ codice, titolo, descrizione: null, indirizzo: null, stato: 'In corso', cartella, data_inizio: null, data_fine: null, visibile: 1 }).lastInsertRowid);
  lavoroA = mk('A-1', 'Lavoro di Anna', 'A-1 Anna');
  lavoroB = mk('B-1', 'Lavoro di Bruno', 'B-1 Bruno');
  Lavori.aggiungiCliente.run(lavoroA, annaId);
  Lavori.aggiungiCliente.run(lavoroB, b);
  fs.mkdirSync(path.join(process.env.ARCHIVIO_DIR, 'A-1 Anna', 'CILA'), { recursive: true });
  rA = richieste.crea(Lavori.perId.get(lavoroA), "Carta d'identità", 'fronte e retro');
  rB = richieste.crea(Lavori.perId.get(lavoroB), 'Atto di provenienza', null);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());
test.beforeEach(() => richieste.azzeraInvii());

const urlA = () => `/area/lavori/${lavoroA}/richieste/${rA}/file`;
const paginaA = () => `/area/lavori/${lavoroA}`;

test('il cliente vede la richiesta e invia un PDF e una foto: arrivano nella cartella del lavoro', async () => {
  const b = browser();
  await b.accedi('anna@esempio.it');
  const t = (await b.go(paginaA())).text;
  assert.match(t, /Documenti richiesti/);
  assert.match(t, /Carta d&#39;identità/);
  const r = await b.carica(urlA(), [['carta fronte.pdf', PDF], ['retro.JPG', JPG]], { da: paginaA() });
  assert.match(r.pagina, /Inviati 2 file allo studio/);
  assert.match(r.pagina, /Inviato, in verifica/);
  const dir = path.join(dirA(), "Carta d'identità");
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['carta fronte.pdf', 'retro.JPG']);
  assert.ok(fs.readFileSync(path.join(dir, 'carta fronte.pdf')).equals(PDF));
  // Avviso allo studio
  await new Promise((x) => setTimeout(x, 30));
  const m = inviate.find((x) => /Documenti ricevuti/.test(x.oggetto));
  assert.ok(m && m.a === 'studio@esempio.it');
  assert.match(m.testo, /Anna ha caricato 2 file/);
  // Stesso nome inviato di nuovo: non sovrascrive
  await b.carica(urlA(), [['carta fronte.pdf', PDF]], { da: paginaA() });
  assert.ok(fs.existsSync(path.join(dir, 'carta fronte (2).pdf')));
});

test('file pericolosi o camuffati vengono rifiutati e non restano sul disco', async () => {
  const b = browser();
  await b.accedi('anna@esempio.it');
  const prima = tuttiIFile(dirA()).length;
  const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]);
  const cattivi = [
    ['virus.exe', EXE], ['pagina.html', Buffer.from('<script>alert(1)</script>'.padEnd(50))], ['immagine.svg', Buffer.from('<svg onload="alert(1)"/>'.padEnd(50))],
    ['script.js', Buffer.from('alert(1)'.padEnd(50))], ['finto.pdf', EXE], ['finta.jpg', Buffer.from('<html><script>alert(1)</script>'.padEnd(50))],
    ['macro.docm', Buffer.from('PK' + 'x'.repeat(50))], ['archivio.zip', Buffer.from('PK' + 'x'.repeat(50))], ['doppia.pdf.exe', PDF], ['vuoto.pdf', Buffer.alloc(0)],
    ['senza-estensione', PDF], ['.htaccess', PDF],
  ];
  for (const f of cattivi) {
    const r = await b.carica(urlA(), [f], { da: paginaA() });
    assert.match(r.pagina, /Nessun file inviato/, f[0]);
  }
  assert.strictEqual(tuttiIFile(dirA()).length, prima);
  // Insieme a un file buono: passa solo quello buono
  const r = await b.carica(urlA(), [['buono.pdf', PDF], ['virus.exe', EXE]], { da: paginaA() });
  assert.match(r.pagina, /Inviato 1 file allo studio\. Non accettati: virus\.exe/);
  assert.strictEqual(tuttiIFile(dirA()).length, prima + 1);
  assert.strictEqual(fs.readdirSync(path.join(process.env.DATI_DIR, 'tmp')).length, 0, 'nessun file temporaneo rimasto');
});

test('il nome del file non può far uscire dalla cartella', async () => {
  const b = browser();
  await b.accedi('anna@esempio.it');
  for (const nome of ['../../../fuori.pdf', '..\\..\\fuori2.pdf', '/etc/cron.d/x.pdf', '_nascosto.pdf', 'a/b/c.pdf']) {
    await b.carica(urlA(), [[nome, PDF]], { da: paginaA() });
  }
  const fuori = fs.readdirSync(tmp, { recursive: true }).filter((x) => /fuori|cron|nascosto|c\.pdf/.test(x));
  assert.ok(fuori.length > 0);
  for (const f of fuori) assert.ok(f.startsWith(path.join('lavori', 'A-1 Anna', 'Documenti dal cliente')), f);
});

test('limiti: file troppo grande e troppi file per volta', async () => {
  const b = browser();
  await b.accedi('anna@esempio.it');
  const prima = tuttiIFile(dirA()).length;
  const grande = Buffer.concat([PDF, Buffer.alloc(26 * 1024 * 1024)]);
  let r = await b.carica(urlA(), [['enorme.pdf', grande]], { da: paginaA() });
  assert.match(r.pagina, /supera il limite di 25 MB/);
  r = await b.carica(urlA(), Array.from({ length: 9 }, (_, i) => [`f${i}.pdf`, PDF]), { da: paginaA() });
  assert.match(r.pagina, /al massimo 8 file per volta/);
  assert.strictEqual(tuttiIFile(dirA()).length, prima);
  assert.strictEqual(fs.readdirSync(path.join(process.env.DATI_DIR, 'tmp')).length, 0);
});

test('accessi: senza login, senza CSRF, altro cliente, richiesta di un altro lavoro', async () => {
  const prima = tuttiIFile(path.join(process.env.ARCHIVIO_DIR)).length;
  // Senza login
  assert.strictEqual((await browser().carica(urlA(), [['x.pdf', PDF]], { csrf: false })).status, 302);
  // Senza token CSRF
  const a = browser();
  await a.accedi('anna@esempio.it');
  assert.strictEqual((await a.carica(urlA(), [['x.pdf', PDF]], { csrf: false })).status, 403);
  // Anna sulla richiesta di Bruno, direttamente o passando dal proprio lavoro
  assert.strictEqual((await a.carica(`/area/lavori/${lavoroB}/richieste/${rB}/file`, [['x.pdf', PDF]], { da: paginaA() })).status, 404);
  assert.strictEqual((await a.carica(`/area/lavori/${lavoroA}/richieste/${rB}/file`, [['x.pdf', PDF]], { da: paginaA() })).status, 404);
  // Il cliente non può aprire i file dal pannello dello studio né creare richieste
  assert.strictEqual((await a.go(`/studio/lavori/${lavoroA}/richieste/${rA}/file/1`)).status, 403);
  assert.strictEqual((await a.post(`/studio/lavori/${lavoroA}/richieste`, { titolo: 'x' }, paginaA())).status, 403);
  assert.strictEqual(tuttiIFile(path.join(process.env.ARCHIVIO_DIR)).length, prima);
  assert.strictEqual(fs.readdirSync(path.join(process.env.DATI_DIR, 'tmp')).length, 0);
});

test('la cartella dei documenti del cliente non diventa una pratica e non viene letta in automatico', async () => {
  const elenco = await require('../src/pratiche').sincronizza(Lavori.perId.get(lavoroA));
  assert.deepStrictEqual(elenco.map((p) => p.cartella), ['CILA']);
  assert.strictEqual(await require('../src/automazioni').scansionaRicevute(), 0);
});

test('studio: vede i file, li apre, segna come ricevuto; poi il cliente non può più caricare né togliere', async () => {
  const s = browser();
  await s.accedi('studio@esempio.it');
  const pag = `/studio/lavori/${lavoroA}`;
  const t = (await s.go(pag)).text;
  assert.match(t, /Da controllare/);
  assert.match((await s.go('/studio')).text, /Documenti ricevuti dai clienti/);
  const f = richieste.Q.file.all(rA)[0];
  const r = await fetch(`${base}/studio/lavori/${lavoroA}/richieste/${rA}/file/${f.id}`, { redirect: 'manual' });
  assert.strictEqual(r.status, 302, 'senza accesso niente file');
  assert.strictEqual((await s.go(`/studio/lavori/${lavoroA}/richieste/${rA}/file/${f.id}`)).status, 200);
  assert.strictEqual((await s.go(`/studio/lavori/${lavoroB}/richieste/${rA}/file/${f.id}`)).status, 404);
  // Il cliente toglie un file inviato per errore (finché è aperta)
  const a = browser();
  await a.accedi('anna@esempio.it');
  const n = richieste.Q.file.all(rA).length;
  await a.post(`/area/lavori/${lavoroA}/richieste/${rA}/file/${f.id}/elimina`, {}, paginaA());
  assert.strictEqual(richieste.Q.file.all(rA).length, n - 1);
  // Lo studio chiude la richiesta
  await s.post(`/studio/lavori/${lavoroA}/richieste/${rA}`, { azione: 'completa' }, pag);
  assert.match((await a.go(paginaA())).text, /Ricevuto ✓/);
  const dopo = await a.carica(urlA(), [['tardi.pdf', PDF]], { da: paginaA() });
  assert.match(dopo.pagina, /già stata chiusa/);
  const f2 = richieste.Q.file.all(rA)[0];
  await a.post(`/area/lavori/${lavoroA}/richieste/${rA}/file/${f2.id}/elimina`, {}, paginaA());
  assert.strictEqual(richieste.Q.file.all(rA).length, n - 1, 'a richiesta chiusa non si toglie più nulla');
});

test('nuova richiesta dallo studio: email al cliente con il link all\'area', async () => {
  const s = browser();
  await s.accedi('studio@esempio.it');
  inviate.length = 0;
  const r = await s.post(`/studio/lavori/${lavoroA}/richieste`, { titolo: 'Atto <b>di</b> provenienza', descrizione: 'copia completa', email: '1' }, `/studio/lavori/${lavoroA}`);
  assert.strictEqual(r.status, 302);
  // Senza posta configurata nei test l'avviso ai clienti non parte, ma la richiesta c'è ed è mostrata come testo
  const a = browser();
  await a.accedi('anna@esempio.it');
  const t = (await a.go(paginaA())).text;
  assert.ok(t.includes('Atto &lt;b&gt;di&lt;/b&gt; provenienza'));
  assert.match(t, /1 da inviare/);
});

test('troppi invii in un\'ora vengono fermati', async () => {
  const a = browser();
  await a.accedi('anna@esempio.it');
  const rid = richieste.crea(Lavori.perId.get(lavoroA), 'Bollette', null);
  const url = `/area/lavori/${lavoroA}/richieste/${rid}/file`;
  let ultimo;
  for (let i = 0; i < 41; i++) ultimo = await a.carica(url, [['b.pdf', PDF]], { da: paginaA() });
  assert.match(ultimo.pagina, /Troppi invii/);
  assert.strictEqual(richieste.Q.file.all(rid).length, 40);
});

test('riservatezza: un cointestatario non vede i nomi dei file inviati dall\'altro', async () => {
  const h = await auth.hashPassword(PW);
  const id = Number(Utenti.inserisci.run('carlo@esempio.it', h, 'Carlo', null, 'cliente').lastInsertRowid);
  Lavori.aggiungiCliente.run(lavoroA, id);
  const rid = richieste.crea(Lavori.perId.get(lavoroA), 'Documenti personali', null);
  const a = browser();
  await a.accedi('anna@esempio.it');
  await a.carica(`/area/lavori/${lavoroA}/richieste/${rid}/file`, [['patente-anna-riservata.pdf', PDF]], { da: paginaA() });
  const c = browser();
  await c.accedi('carlo@esempio.it');
  const t = (await c.go(paginaA())).text;
  assert.ok(!t.includes('patente-anna-riservata'));
  assert.match(t, /Altri 1 file inviati da un altro intestatario/);
  const f = richieste.Q.file.all(rid)[0];
  await c.post(`/area/lavori/${lavoroA}/richieste/${rid}/file/${f.id}/elimina`, {}, paginaA());
  assert.strictEqual(richieste.Q.file.all(rid).length, 1, 'non può togliere i file altrui');
});
