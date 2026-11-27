'use strict';
/**
 * Prove di sicurezza e robustezza sull'app completa (server avviato in memoria):
 * accessi non autorizzati, CSRF, percorsi malevoli, XSS, input anomali, limiti di accesso.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sicurezza-'));
process.env.ARCHIVIO_DIR = path.join(tmp, 'lavori');
process.env.DATI_DIR = path.join(tmp, 'app');
fs.mkdirSync(process.env.ARCHIVIO_DIR, { recursive: true });

const app = require('../src/server');
const auth = require('../src/auth');
const imprese = require('../src/imprese');
const { Utenti, Lavori, db } = require('../src/modelli');

let base;
let server;

function browser() {
  let cookie = '';
  return {
    async go(p, opt = {}) {
      const r = await fetch(base + p, { redirect: 'manual', ...opt, headers: { ...(opt.headers || {}), cookie } });
      const sc = r.headers.getSetCookie();
      if (sc.length) cookie = sc.map((s) => s.split(';')[0]).join('; ');
      return { status: r.status, loc: r.headers.get('location'), headers: r.headers, text: await r.text() };
    },
    async csrf(p = '/accedi') {
      const t = (await this.go(p)).text;
      const m = t.match(/name="_csrf" value="([^"]+)"/);
      return m ? m[1] : '';
    },
    async post(p, dati, { da, senzaCsrf = false } = {}) {
      const tok = senzaCsrf ? '' : await this.csrf(da || '/accedi');
      const body = dati instanceof FormData ? dati : new URLSearchParams(Object.entries(dati));
      if (!senzaCsrf) body.append('_csrf', tok);
      return this.go(p, { method: 'POST', body });
    },
    async accedi(email, password) {
      return this.post('/accedi', { email, password });
    },
  };
}

const PW = 'PasswordSicura123';
let lavoroA; let lavoroB; let impresaId; let docId; let verbaleId;

test.before(async () => {
  const h = await auth.hashPassword(PW);
  Utenti.inserisci.run('studio@esempio.it', h, 'Studio', null, 'admin');
  const a = Number(Utenti.inserisci.run('anna@esempio.it', h, 'Anna <b>Cliente</b>', null, 'cliente').lastInsertRowid);
  const b = Number(Utenti.inserisci.run('bruno@esempio.it', h, 'Bruno', null, 'cliente').lastInsertRowid);
  const mk = (codice, titolo, cartella) => Number(Lavori.inserisci.run({ codice, titolo, descrizione: null, indirizzo: null, stato: 'In corso', cartella, data_inizio: null, data_fine: null, visibile: 1 }).lastInsertRowid);
  lavoroA = mk('A-1', 'Lavoro di Anna <script>alert(1)</script>', 'A-1 Anna');
  lavoroB = mk('B-1', 'Lavoro di Bruno', 'B-1 Bruno');
  Lavori.aggiungiCliente.run(lavoroA, a);
  Lavori.aggiungiCliente.run(lavoroB, b);
  // Cartelle sul "NAS": una pratica visibile, un file nascosto e un file fuori archivio
  const dirA = path.join(process.env.ARCHIVIO_DIR, 'A-1 Anna', 'CILA');
  fs.mkdirSync(dirA, { recursive: true });
  fs.writeFileSync(path.join(dirA, 'tavola.pdf'), '%PDF-1.4 finto');
  fs.writeFileSync(path.join(dirA, '_bozza.pdf'), 'segreto');
  fs.writeFileSync(path.join(dirA, 'rotto.pdf'), 'non è un pdf');
  fs.mkdirSync(path.join(process.env.ARCHIVIO_DIR, 'B-1 Bruno', 'SCIA'), { recursive: true });
  fs.writeFileSync(path.join(process.env.ARCHIVIO_DIR, 'B-1 Bruno', 'SCIA', 'privato.pdf'), 'di Bruno');
  fs.writeFileSync(path.join(tmp, 'segreto.txt'), 'fuori archivio');
  await require('../src/pratiche').sincronizza(Lavori.perId.get(lavoroA));
  await require('../src/pratiche').sincronizza(Lavori.perId.get(lavoroB));
  db.prepare('UPDATE pratiche SET visibile = 1').run();
  // Per le prove: lo studio ha pubblicato la tavola (gli altri file restano privati)
  const pubblicati = require('../src/pubblicati');
  pubblicati.pubblica(Lavori.perId.get(lavoroA), db.prepare('SELECT * FROM pratiche WHERE lavoro_id = ?').get(lavoroA), 'tavola.pdf');
  pubblicati.pubblica(Lavori.perId.get(lavoroB), db.prepare('SELECT * FROM pratiche WHERE lavoro_id = ?').get(lavoroB), 'privato.pdf');
  // Sicurezza cantiere su A: impresa con un documento e un verbale
  imprese.Q.impostaSicurezza.run(1, lavoroA);
  impresaId = Number(imprese.Q.inserisci.run({ ragione_sociale: 'Edile <img src=x onerror=alert(1)>', piva: null, sede: null, pec: null, telefono: null, autonomo: 0, nota: 'nota interna riservata' }).lastInsertRowid);
  imprese.Q.collega.run(lavoroA, impresaId, 'Affidataria', 1);
  const f = path.join(tmp, 'durc.pdf'); fs.writeFileSync(f, '%PDF-1.4 durc');
  docId = await imprese.salvaDocumento(impresaId, { tipo: 'durc', rilascio: '2026-11-01' }, f, '../../durc.pdf');
  verbaleId = await imprese.salvaVerbale(lavoroA, { data: '2026-11-10', tipo: 'Sopralluogo del CSE', note: null, visibile: 1 }, f, 'verbale.pdf');

  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const pratica = (lavoro) => db.prepare('SELECT id FROM pratiche WHERE lavoro_id = ?').get(lavoro).id;

test('senza accesso: tutte le aree riservate rimandano al login', async () => {
  const b = browser();
  for (const p of ['/area', `/area/lavori/${lavoroA}`, '/studio', '/studio/imprese', `/studio/lavori/${lavoroA}`, `/area/lavori/${lavoroA}/file?p=1&f=tavola.pdf`]) {
    const r = await b.go(p);
    assert.strictEqual(r.status, 302, p);
    assert.strictEqual(r.loc, '/accedi', p);
  }
});

test('intestazioni di sicurezza presenti', async () => {
  const r = await browser().go('/accedi');
  assert.match(r.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.strictEqual(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(r.headers.get('x-powered-by'), null);
  const sc = (await browser().go('/accedi')).headers.getSetCookie().join(';');
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /SameSite=Lax/i);
});

test('login: password errata, utente inesistente e campi enormi non entrano', async () => {
  const b = browser();
  assert.strictEqual((await b.accedi('anna@esempio.it', 'sbagliata')).status, 401);
  assert.strictEqual((await b.accedi('nessuno@esempio.it', PW)).status, 401);
  assert.strictEqual((await b.accedi('x'.repeat(5000), 'y'.repeat(5000))).status, 401);
  assert.strictEqual((await b.accedi("' OR 1=1 --", "' OR '1'='1")).status, 401);
});

test('CSRF: le richieste senza token vengono rifiutate', async () => {
  const b = browser();
  await b.accedi('studio@esempio.it', PW);
  const r = await b.post('/studio/imprese', { ragione_sociale: 'Intrusa' }, { senzaCsrf: true });
  assert.strictEqual(r.status, 403);
  const r2 = await b.post(`/studio/lavori/${lavoroA}/elimina`, {}, { senzaCsrf: true });
  assert.strictEqual(r2.status, 403);
  assert.ok(Lavori.perId.get(lavoroA), 'il lavoro non deve essere eliminato');
  const r3 = await b.go('/studio/imprese', { method: 'POST', body: new URLSearchParams({ ragione_sociale: 'X', _csrf: 'a'.repeat(48) }) });
  assert.strictEqual(r3.status, 403);
});

test('cliente: non vede il pannello dello studio né i lavori di altri', async () => {
  const b = browser();
  const r = await b.accedi('anna@esempio.it', PW);
  assert.strictEqual(r.loc, '/area');
  assert.strictEqual((await b.go('/studio')).status, 403);
  assert.strictEqual((await b.go('/studio/imprese')).status, 403);
  assert.strictEqual((await b.go(`/studio/imprese/${impresaId}/documenti/${docId}`)).status, 403);
  assert.strictEqual((await b.post('/studio/imprese', { ragione_sociale: 'X' }, { da: '/area' })).status, 403);
  assert.strictEqual((await b.go(`/area/lavori/${lavoroB}`)).status, 404);
  assert.strictEqual((await b.go(`/area/lavori/${lavoroB}/file?p=${pratica(lavoroB)}&f=privato.pdf`)).status, 404);
  // Pratica di Bruno chiesta passando dal lavoro di Anna
  assert.strictEqual((await b.go(`/area/lavori/${lavoroA}/file?p=${pratica(lavoroB)}&f=privato.pdf`)).status, 404);
});

test('percorsi malevoli e file nascosti non sono raggiungibili', async () => {
  const b = browser();
  await b.accedi('anna@esempio.it', PW);
  const p = pratica(lavoroA);
  assert.strictEqual((await b.go(`/area/lavori/${lavoroA}/file?p=${p}&f=tavola.pdf`)).status, 200);
  const cattivi = ['../../segreto.txt', '..%2F..%2Fsegreto.txt', '/etc/passwd', '_bozza.pdf', '..\\..\\segreto.txt',
    '../../B-1 Bruno/SCIA/privato.pdf', 'tavola.pdf\0.txt', '%00', '.', '', 'x'.repeat(5000)];
  for (const f of cattivi) {
    const r = await b.go(`/area/lavori/${lavoroA}/file?p=${p}&f=${encodeURIComponent(f)}`);
    assert.notStrictEqual(r.status, 200, f);
    assert.ok(r.status < 500, `${f} → ${r.status}`);
    assert.ok(!r.text.includes('fuori archivio') && !r.text.includes('segreto') && !r.text.includes('di Bruno'), f);
  }
});

test('XSS: nomi e titoli inseriti vengono mostrati come testo', async () => {
  const b = browser();
  await b.accedi('anna@esempio.it', PW);
  const t = (await b.go(`/area/lavori/${lavoroA}`)).text;
  assert.ok(!t.includes('<script>alert(1)</script>'));
  assert.ok(t.includes('&lt;script&gt;'));
  assert.ok(!t.includes('<img src=x'));
  assert.ok(!t.includes('nota interna riservata'), 'le note interne sull\'impresa non vanno al cliente');
});

test('sicurezza cantiere: visibile solo se attiva, file solo se collegati e visibili', async () => {
  const b = browser();
  await b.accedi('anna@esempio.it', PW);
  const doc = `/area/lavori/${lavoroA}/imprese/${impresaId}/documenti/${docId}`;
  const verb = `/area/lavori/${lavoroA}/verbali/${verbaleId}`;
  let t = (await b.go(`/area/lavori/${lavoroA}`)).text;
  assert.ok(t.includes('Sicurezza in cantiere') && t.includes('Sopralluogo del CSE'));
  assert.strictEqual((await b.go(doc)).status, 200);
  assert.strictEqual((await b.go(verb)).status, 200);
  // Stessi documenti chiesti dal lavoro di Bruno o con id sbagliati
  assert.strictEqual((await b.go(`/area/lavori/${lavoroB}/imprese/${impresaId}/documenti/${docId}`)).status, 404);
  assert.strictEqual((await b.go(`/area/lavori/${lavoroA}/imprese/${impresaId}/documenti/9999`)).status, 404);
  // Verbale privato
  imprese.Q.visibilitaVerbale.run(0, verbaleId, lavoroA);
  assert.strictEqual((await b.go(verb)).status, 404);
  imprese.Q.visibilitaVerbale.run(1, verbaleId, lavoroA);
  // Sezione disattivata: sparisce tutto, anche i link diretti
  imprese.Q.impostaSicurezza.run(0, lavoroA);
  t = (await b.go(`/area/lavori/${lavoroA}`)).text;
  assert.ok(!t.includes('Sicurezza in cantiere'));
  assert.strictEqual((await b.go(doc)).status, 404);
  assert.strictEqual((await b.go(verb)).status, 404);
  imprese.Q.impostaSicurezza.run(1, lavoroA);
});

test('il nome del file caricato non può uscire dalla cartella', () => {
  const d = imprese.Q.documento.get(docId, impresaId);
  assert.ok(!d.file.includes('/') && !d.file.includes('..'));
  assert.ok(imprese.percorsoFile(d).startsWith(path.join(process.env.DATI_DIR, 'imprese')));
});

test('input anomali non causano errori del server', async () => {
  const b = browser();
  await b.accedi('studio@esempio.it', PW);
  const percorsi = ['/studio/lavori/abc', '/studio/lavori/-1', '/studio/lavori/1e309', '/studio/lavori/99999999999999999999',
    '/studio/imprese/abc', '/studio/imprese/0/documenti/xyz', '/studio/clienti/abc', `/studio/lavori/${lavoroA}/verbali/abc`,
    `/studio/lavori/${lavoroA}/file?p=abc&f=`, '/area/lavori/%E0%A4%A', '/%2e%2e/%2e%2e/etc/passwd', '/css/../../package.json'];
  for (const p of percorsi) {
    const r = await b.go(p);
    assert.ok(r.status < 500, `${p} → ${r.status}`);
    assert.ok(!r.text.includes('"dependencies"'), p);
  }
  const tok = await b.csrf('/studio');
  const post = async (p, dati) => (await b.go(p, { method: 'POST', body: new URLSearchParams({ ...dati, _csrf: tok }) })).status;
  assert.ok(await post(`/studio/lavori/${lavoroA}/pratiche/abc`, { stato: 'X'.repeat(10000) }) < 500);
  assert.ok(await post(`/studio/lavori/${lavoroA}/verbali`, { data: '2026-99-99', tipo: '' }) < 500);
  assert.ok(await post(`/studio/lavori/${lavoroA}/imprese`, { impresa: "1; DROP TABLE imprese" }) < 500);
  assert.ok(await post(`/studio/imprese/${impresaId}/documenti`, { tipo: 'patente', crediti: '-5' }) < 500);
  assert.ok(await post('/studio/imprese', { ragione_sociale: 'Z'.repeat(100000) }) < 500);
  assert.ok(imprese.Q.tutte.all().length >= 1, 'la tabella esiste ancora');
  // Multipart rotto
  const r = await b.go(`/studio/imprese/${impresaId}/documenti`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=xxx' }, body: '--xxx\r\nrotto' });
  assert.ok(r.status < 500, `multipart → ${r.status}`);
  // Il server risponde ancora
  assert.strictEqual((await b.go('/studio')).status, 200);
});

test('redirect dopo il login: niente rimandi verso altri siti', async () => {
  for (const dopo of ['//evil.example', '/\\evil.example', '/%5Cevil.example']) {
    const b = browser();
    await b.go(`/area${dopo.slice(1) ? '' : ''}`); // crea la sessione
    // Simula un indirizzo "dopo login" malevolo salvato in sessione
    db.prepare("UPDATE sessioni SET dati = json_set(dati, '$.dopoLogin', ?)").run(dopo);
    const r = await b.accedi('anna@esempio.it', PW);
    assert.ok(r.loc === '/area' || (r.loc.startsWith('/') && !/^\/[\\/]/.test(r.loc)), `${dopo} → ${r.loc}`);
  }
});

test('cliente disattivato: perde subito l\'accesso', async () => {
  const b = browser();
  await b.accedi('bruno@esempio.it', PW);
  assert.strictEqual((await b.go(`/area/lavori/${lavoroB}`)).status, 200);
  const u = Utenti.perEmail.get('bruno@esempio.it');
  Utenti.aggiorna.run(u.email, u.nome, u.telefono, 0, u.id);
  assert.strictEqual((await b.go(`/area/lavori/${lavoroB}`)).status, 302);
  assert.strictEqual((await browser().accedi('bruno@esempio.it', PW)).status, 401);
  Utenti.aggiorna.run(u.email, u.nome, u.telefono, 1, u.id);
});

test('la lettura automatica non si ferma su PDF rotti', async () => {
  const automazioni = require('../src/automazioni');
  const n = await automazioni.scansionaRicevute();
  assert.strictEqual(typeof n, 'number');
});

test('5 password sbagliate: blocco di un\'ora, avviso allo studio, sblocco dal pannello', async () => {
  const notifiche = require('../src/notifiche');
  const posta = require('../src/posta');
  const inviate = [];
  const originale = posta.invia;
  posta.invia = async (m) => { inviate.push(m); return true; };
  try {
    db.prepare('DELETE FROM tentativi_accesso').run(); // riparte da zero: le prove precedenti hanno già contato errori
    const b = browser();
    for (let i = 0; i < 4; i++) assert.match((await b.accedi('bruno@esempio.it', 'sbagliata' + i)).text, /non corretti/);
    assert.strictEqual(inviate.length, 0, 'nessun avviso prima del quinto errore');
    await b.accedi('bruno@esempio.it', 'sbagliata5');
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(inviate.length, 1, 'un solo avviso al quinto errore');
    assert.strictEqual(inviate[0].a, 'studio@esempio.it');
    assert.match(inviate[0].oggetto, /Accesso bloccato: bruno@esempio.it/);
    assert.match(inviate[0].testo, /cliente: Bruno/);
    // Bloccato anche con la password giusta, e nessun secondo avviso
    const r = await b.accedi('bruno@esempio.it', PW);
    assert.strictEqual(r.status, 401);
    assert.match(r.text, /Troppi tentativi\. Riprova tra un(&#39;|')ora/);
    await new Promise((r2) => setTimeout(r2, 50));
    assert.strictEqual(inviate.length, 1);
    // Il blocco è nel database (resiste al riavvio) e dura un'ora
    const blocco = auth.blocchiAttivi().find((x) => x.email === 'bruno@esempio.it');
    assert.ok(blocco);
    assert.ok(Math.abs(blocco.fino - blocco.bloccato_dal - 60 * 60 * 1000) < 5);
    // Lo studio lo vede nel pannello e lo sblocca
    const s = browser();
    await s.accedi('studio@esempio.it', PW);
    assert.match((await s.go('/studio')).text, /Accessi bloccati[\s\S]*bruno@esempio\.it/);
    assert.strictEqual((await browser().post('/studio/blocchi/sblocca', { chiave: blocco.chiave })).status, 302, 'senza accesso non si sblocca');
    assert.ok(auth.blocchiAttivi().some((x) => x.email === 'bruno@esempio.it'));
    await s.post('/studio/blocchi/sblocca', { chiave: blocco.chiave }, { da: '/studio' });
    assert.strictEqual((await browser().accedi('bruno@esempio.it', PW)).loc, '/area');
  } finally { posta.invia = originale; }
});

test('il blocco scade dopo un\'ora e non prima', () => {
  const req = { ip: '203.0.113.9' };
  for (let i = 0; i < 5; i++) auth.registraErrore(req, 'tempo@esempio.it');
  assert.ok(auth.loginBloccato(req, 'tempo@esempio.it'));
  const k = '203.0.113.9|tempo@esempio.it';
  db.prepare('UPDATE tentativi_accesso SET bloccato_dal = ? WHERE chiave = ?').run(Date.now() - 59 * 60 * 1000, k);
  assert.ok(auth.loginBloccato(req, 'tempo@esempio.it'), 'dopo 59 minuti è ancora bloccato');
  db.prepare('UPDATE tentativi_accesso SET bloccato_dal = ? WHERE chiave = ?').run(Date.now() - 61 * 60 * 1000, k);
  assert.ok(!auth.loginBloccato(req, 'tempo@esempio.it'), 'dopo 61 minuti è libero');
  // Da un altro indirizzo la stessa email non è bloccata: nessuno può chiudere fuori un cliente a distanza
  for (let i = 0; i < 5; i++) auth.registraErrore(req, 'altro@esempio.it');
  assert.ok(!auth.loginBloccato({ ip: '198.51.100.7' }, 'altro@esempio.it'));
});

test('molte email diverse dallo stesso indirizzo: blocco dell\'indirizzo e un solo avviso', async () => {
  const posta = require('../src/posta');
  const inviate = [];
  const originale = posta.invia;
  posta.invia = async (m) => { inviate.push(m); return true; };
  try {
    db.prepare('DELETE FROM tentativi_accesso').run();
    const b = browser();
    for (let i = 0; i < 20; i++) await b.accedi(`ignoto${i}@esempio.it`, 'x');
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(inviate.filter((m) => /indirizzo/.test(m.oggetto)).length, 1);
    const r = await b.accedi('anna@esempio.it', PW);
    assert.match(r.text, /Troppi tentativi/);
    // Un errore di invio della posta non fa cadere nulla
    db.prepare('DELETE FROM tentativi_accesso').run();
    posta.invia = async () => { throw new Error('SMTP giù'); };
    for (let i = 0; i < 5; i++) assert.strictEqual((await b.accedi('anna@esempio.it', 'no' + i)).status, 401);
    await new Promise((r2) => setTimeout(r2, 50));
    db.prepare('DELETE FROM tentativi_accesso').run();
    assert.strictEqual((await browser().accedi('anna@esempio.it', PW)).loc, '/area');
  } finally { posta.invia = originale; }
});

test('privacy: informativa pubblica, link nelle pagine, niente indicizzazione, copia dei propri dati', async () => {
  const anon = browser();
  const inf = await anon.go('/privacy');
  assert.strictEqual(inf.status, 200);
  for (const t of ['2016/679', '196', 'Garante', 'Aruba', 'studio.sid', 'art. 77', '12 mesi']) assert.ok(inf.text.includes(t), t);
  assert.match((await anon.go('/accedi')).text, /href="\/privacy"/);
  assert.match(inf.headers.get('x-robots-tag') || '', /noindex/);
  assert.match((await anon.go('/robots.txt')).text, /Disallow: \//);
  // Un solo cookie, tecnico
  const sc = (await browser().go('/accedi')).headers.getSetCookie();
  assert.strictEqual(sc.length, 1);
  assert.match(sc[0], /^studio\.sid=/);
  // Copia dei dati: solo i propri
  db.prepare('DELETE FROM tentativi_accesso').run();
  assert.strictEqual((await anon.go('/area/profilo/dati')).status, 302);
  const b = browser();
  await b.accedi('anna@esempio.it', PW);
  const dati = JSON.parse((await b.go('/area/profilo/dati')).text);
  assert.strictEqual(dati.account.email, 'anna@esempio.it');
  assert.ok(dati.account.informativa_vista_il, 'presa visione registrata');
  assert.deepStrictEqual(dati.lavori.map((l) => l.codice), ['A-1']);
  const testo = JSON.stringify(dati);
  assert.ok(!testo.includes('bruno') && !testo.includes('password') && !testo.includes('nota interna'));
});

test('privacy: le consultazioni più vecchie di 12 mesi vengono cancellate', () => {
  const u = Utenti.perEmail.get('anna@esempio.it');
  db.prepare("INSERT INTO accessi_file (lavoro_id, utente_id, file, creato_il) VALUES (?, ?, 'vecchio.pdf', datetime('now', '-13 months'))").run(lavoroA, u.id);
  db.prepare("INSERT INTO accessi_file (lavoro_id, utente_id, file, creato_il) VALUES (?, ?, 'recente.pdf', datetime('now', '-11 months'))").run(lavoroA, u.id);
  require('../src/pulizia').esegui();
  const rimasti = db.prepare('SELECT file FROM accessi_file').all().map((r) => r.file);
  assert.ok(!rimasti.includes('vecchio.pdf') && rimasti.includes('recente.pdf'));
});

test('privacy: eliminando un cliente spariscono account, sessioni e collegamenti', async () => {
  const h = await auth.hashPassword(PW);
  const id = Number(Utenti.inserisci.run('temp@esempio.it', h, 'Temporaneo', '333', 'cliente').lastInsertRowid);
  Lavori.aggiungiCliente.run(lavoroA, id);
  const c = browser();
  await c.accedi('temp@esempio.it', PW);
  await c.go(`/area/lavori/${lavoroA}/file?p=${pratica(lavoroA)}&f=tavola.pdf`);
  const s = browser();
  await s.accedi('studio@esempio.it', PW);
  await s.post(`/studio/clienti/${id}/elimina`, {}, { da: '/studio' });
  assert.strictEqual(Utenti.perEmail.get('temp@esempio.it'), undefined);
  assert.strictEqual((await c.go('/area')).status, 302, 'sessione chiusa');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM lavori_clienti WHERE utente_id = ?').get(id).n, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM accessi_file WHERE utente_id = ?').get(id).n, 0);
});

test('riservatezza: il cliente vede solo i documenti pubblicati; i sensibili mai', async () => {
  const pubblicati = require('../src/pubblicati');
  const lavoro = Lavori.perId.get(lavoroA);
  const pr = db.prepare('SELECT * FROM pratiche WHERE lavoro_id = ?').get(lavoroA);
  const dir = path.join(process.env.ARCHIVIO_DIR, 'A-1 Anna', 'CILA');
  const PDF = '%PDF-1.4 x';
  for (const n of ['relazione.pdf', "Carta d'identità Rossi.pdf", 'C.I. e C.F. Anna.pdf', 'Procura speciale.pdf', 'Codice_Fiscale.jpg', 'IBAN.pdf', 'certificato medico.pdf', 'Protocollo 730.pdf'])
    fs.writeFileSync(path.join(dir, n), PDF);
  fs.mkdirSync(path.join(dir, 'Documenti identita'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Documenti identita', 'scansione001.pdf'), PDF);
  const a = browser();
  await a.accedi('anna@esempio.it', PW);
  const apri = async (f) => (await a.go(`/area/lavori/${lavoroA}/file?p=${pr.id}&f=${encodeURIComponent(f)}`)).status;
  // File appena arrivato nella cartella: privato
  assert.strictEqual(await apri('relazione.pdf'), 404);
  assert.ok(!(await a.go(`/area/lavori/${lavoroA}`)).text.includes('relazione.pdf'));
  // Lo studio lo pubblica
  const s = browser();
  await s.accedi('studio@esempio.it', PW);
  const pag = `/studio/lavori/${lavoroA}`;
  await s.post(`${pag}/documenti/visibilita`, { p: pr.id, f: 'relazione.pdf', azione: 'pubblica' }, { da: pag });
  assert.strictEqual(await apri('relazione.pdf'), 200);
  // I sensibili non si pubblicano: né uno per uno, né con "pubblica tutti", né scrivendo nel database
  const sensibili = ["Carta d'identità Rossi.pdf", 'C.I. e C.F. Anna.pdf', 'Procura speciale.pdf', 'Codice_Fiscale.jpg', 'IBAN.pdf', 'certificato medico.pdf', 'Documenti identita/scansione001.pdf'];
  for (const f of sensibili) await s.post(`${pag}/documenti/visibilita`, { p: pr.id, f, azione: 'pubblica' }, { da: pag });
  await s.post(`${pag}/documenti/visibilita`, { p: pr.id, azione: 'tutti' }, { da: pag });
  for (const f of sensibili) db.prepare('INSERT OR REPLACE INTO file_pubblicati (pratica_id, percorso, dimensione, modificato) VALUES (?, ?, ?, ?)').run(pr.id, f, PDF.length, Math.floor(fs.statSync(path.join(dir, f)).mtimeMs));
  const t = (await a.go(`/area/lavori/${lavoroA}`)).text;
  for (const f of sensibili) {
    assert.strictEqual(await apri(f), 404, f);
    assert.ok(!t.includes(path.basename(f).replace("'", '&#39;')), f);
  }
  // Un nome innocuo con un numero non viene scambiato per sensibile
  assert.strictEqual(pubblicati.sembraSensibile('Protocollo 730.pdf'), null);
  assert.strictEqual(await apri('Protocollo 730.pdf'), 200, 'pubblicato da "pubblica tutti"');
  // Se il file pubblicato viene sostituito, torna privato
  fs.writeFileSync(path.join(dir, 'relazione.pdf'), PDF + ' contenuto diverso');
  assert.strictEqual(await apri('relazione.pdf'), 404);
  // Nascondere funziona; il cliente non può pubblicare
  await s.post(`${pag}/documenti/visibilita`, { p: pr.id, f: 'Protocollo 730.pdf', azione: 'nascondi' }, { da: pag });
  assert.strictEqual(await apri('Protocollo 730.pdf'), 404);
  assert.strictEqual((await a.post(`${pag}/documenti/visibilita`, { p: pr.id, f: 'Protocollo 730.pdf', azione: 'pubblica' }, { da: `/area/lavori/${lavoroA}` })).status, 403);
  // Pratica resa privata: nemmeno i pubblicati
  db.prepare('UPDATE pratiche SET visibile = 0 WHERE id = ?').run(pr.id);
  assert.strictEqual(await apri('tavola.pdf'), 404);
  db.prepare('UPDATE pratiche SET visibile = 1 WHERE id = ?').run(pr.id);
  assert.ok(pubblicati.visibile(lavoro, pr, 'tavola.pdf'));
});

test('riservatezza: gli "altri documenti" delle imprese (POS, attestati, idoneità) non arrivano al cliente', async () => {
  const f = path.join(tmp, 'pos.pdf'); fs.writeFileSync(f, '%PDF-1.4 pos');
  const id = await imprese.salvaDocumento(impresaId, { tipo: 'altro', descrizione: 'Idoneità sanitaria lavoratori' }, f, 'idoneita.pdf');
  const a = browser();
  db.prepare('DELETE FROM tentativi_accesso').run();
  await a.accedi('anna@esempio.it', PW);
  assert.ok(!(await a.go(`/area/lavori/${lavoroA}`)).text.includes('Idoneità sanitaria'));
  assert.strictEqual((await a.go(`/area/lavori/${lavoroA}/imprese/${impresaId}/documenti/${id}`)).status, 404);
  assert.strictEqual((await a.go(`/area/lavori/${lavoroA}/imprese/${impresaId}/documenti/${docId}`)).status, 200, 'il DURC resta visibile');
});

test('riservatezza: elenco e apertura dei documenti pubblicati sono sempre coerenti', async () => {
  const pubblicati = require('../src/pubblicati');
  const archivio = require('../src/archivio');
  const lavoro = Lavori.perId.get(lavoroA);
  const pr = db.prepare('SELECT * FROM pratiche WHERE lavoro_id = ?').get(lavoroA);
  const dir = path.join(process.env.ARCHIVIO_DIR, 'A-1 Anna', 'CILA');
  // Date di modifica con frazioni di millisecondo diverse (arrotondamento per eccesso e per difetto)
  for (let i = 0; i < 12; i++) {
    const nome = `elaborato-${i}.pdf`;
    fs.writeFileSync(path.join(dir, nome), '%PDF-1.4');
    const t = 1790000000 + i + (i * 0.0837 % 1) / 1000 + 0.0004 * (i % 3);
    fs.utimesSync(path.join(dir, nome), t, t);
    assert.ok(pubblicati.pubblica(lavoro, pr, nome).ok);
  }
  const elenco = pubblicati.annota(pr, await archivio.documentiPratica(lavoro, 'CILA')).filter((f) => /^elaborato-/.test(f.nome));
  assert.strictEqual(elenco.length, 12);
  for (const f of elenco) {
    assert.ok(f.pubblicato && !f.cambiato, f.nome);
    assert.ok(pubblicati.visibile(lavoro, pr, f.percorso), f.nome);
  }
});

test('cartella Presentazione: i file sono visibili in automatico, i documenti d\'identità mai', async () => {
  const pubblicati = require('../src/pubblicati');
  const pr = db.prepare('SELECT * FROM pratiche WHERE lavoro_id = ?').get(lavoroA);
  const dir = path.join(process.env.ARCHIVIO_DIR, 'A-1 Anna', 'CILA');
  const pres = path.join(dir, 'Presentazione');
  fs.mkdirSync(path.join(pres, 'Tavole'), { recursive: true });
  const buoni = ['Presentazione/Tav01 - Stato attuale.pdf', 'Presentazione/Relazione tecnica.pdf', 'Presentazione/Tavole/Tav02 - Progetto.pdf', 'Presentazione/Modulo CILA.pdf.p7m'];
  const identita = ['Presentazione/Carta di identità Rossi.pdf', 'Presentazione/carta identita.pdf', 'Presentazione/Documento identità Anna.pdf', 'Presentazione/doc ide Rossi.pdf',
    'Presentazione/Doc. Ide. Bianchi.pdf', 'Presentazione/DOC_IDE.pdf', 'Presentazione/doc identità.jpg', 'Presentazione/CARTA_IDENTITA_ROSSI_MARIO.PDF', 'Presentazione/Documento di identità.pdf'];
  for (const f of [...buoni, ...identita, 'Bozza interna.pdf']) fs.writeFileSync(path.join(dir, f), '%PDF-1.4 x');
  db.prepare('DELETE FROM tentativi_accesso').run();
  const a = browser();
  await a.accedi('anna@esempio.it', PW);
  const apri = async (f) => (await a.go(`/area/lavori/${lavoroA}/file?p=${pr.id}&f=${encodeURIComponent(f)}`)).status;
  const pagina = (await a.go(`/area/lavori/${lavoroA}`)).text;
  for (const f of buoni) { assert.strictEqual(await apri(f), 200, f); assert.ok(pagina.includes(path.basename(f)), f); }
  for (const f of identita) {
    assert.ok(pubblicati.sembraSensibile(f), f);
    assert.strictEqual(await apri(f), 404, f);
    assert.ok(!pagina.toLowerCase().includes(path.basename(f).toLowerCase()), f);
  }
  // Fuori dalla cartella Presentazione resta privato
  assert.strictEqual(await apri('Bozza interna.pdf'), 404);
  // Un file aggiunto dopo compare da solo; sostituirlo non lo nasconde
  fs.writeFileSync(path.join(pres, 'Tav03 - Sovrapposto.pdf'), '%PDF-1.4 a');
  assert.strictEqual(await apri('Presentazione/Tav03 - Sovrapposto.pdf'), 200);
  fs.writeFileSync(path.join(pres, 'Tav03 - Sovrapposto.pdf'), '%PDF-1.4 versione nuova');
  assert.strictEqual(await apri('Presentazione/Tav03 - Sovrapposto.pdf'), 200);
  // Varianti del nome della cartella; parole simili non contano
  assert.ok(pubblicati.automatico('01 - Presentazione/x.pdf') && pubblicati.automatico('PRESENTAZIONE CILA/x.pdf') && pubblicati.automatico('presentazione/sub/x.pdf'));
  assert.ok(!pubblicati.automatico('Rappresentazione/x.pdf') && !pubblicati.automatico('Presentazione.pdf') && !pubblicati.automatico('Vecchia/x.pdf'));
  // Pratica resa privata: non si vede più nulla, nemmeno la Presentazione
  db.prepare('UPDATE pratiche SET visibile = 0 WHERE id = ?').run(pr.id);
  assert.strictEqual(await apri(buoni[0]), 404);
  db.prepare('UPDATE pratiche SET visibile = 1 WHERE id = ?').run(pr.id);
  // I file nascosti (che iniziano con _) restano fuori anche lì
  fs.writeFileSync(path.join(pres, '_appunti.pdf'), 'x');
  assert.strictEqual(await apri('Presentazione/_appunti.pdf'), 404);
  // Lo studio può nascondere un file di Presentazione e poi mostrarlo di nuovo
  const lavoro = db.prepare('SELECT * FROM lavori WHERE id = ?').get(lavoroA);
  pubblicati.nascondi(pr, buoni[1]);
  assert.strictEqual(await apri(buoni[1]), 404);
  assert.ok(!(await a.go(`/area/lavori/${lavoroA}`)).text.includes('Relazione tecnica.pdf'));
  const ann = pubblicati.annota(pr, [{ percorso: buoni[1], dimensione: 10, modificato: new Date() }])[0];
  assert.deepStrictEqual([ann.pubblicato, ann.autoNascosto], [false, true]);
  assert.strictEqual(await apri(buoni[0]), 200); // gli altri restano visibili
  assert.ok(pubblicati.pubblica(lavoro, pr, buoni[1]).ok);
  assert.strictEqual(await apri(buoni[1]), 200);
  // «Non pubblicare» nel nome del file o di una sottocartella: mai visibile, nemmeno in Presentazione
  fs.mkdirSync(path.join(pres, 'Non pubblicare'), { recursive: true });
  fs.writeFileSync(path.join(pres, 'Non pubblicare', 'Bozza.pdf'), '%PDF-1.4 b');
  fs.writeFileSync(path.join(pres, 'Tavola - NON PUBBLICARE.pdf'), '%PDF-1.4 c');
  assert.strictEqual(await apri('Presentazione/Non pubblicare/Bozza.pdf'), 404);
  assert.strictEqual(await apri('Presentazione/Tavola - NON PUBBLICARE.pdf'), 404);
  assert.strictEqual(pubblicati.pubblica(lavoro, pr, 'Presentazione/Tavola - NON PUBBLICARE.pdf').ok, false);
  // Studio: «Nascondi tutti» toglie anche la Presentazione; «Scarta» toglie la cartella al cliente e all'elenco
  const st = browser();
  await st.accedi('studio@esempio.it', PW);
  const c = await st.csrf(`/studio/lavori/${lavoroA}`);
  await st.go(`/studio/lavori/${lavoroA}/documenti/visibilita`, { method: 'POST', body: new URLSearchParams({ _csrf: c, p: String(pr.id), azione: 'nascondiTutti' }) });
  assert.strictEqual(await apri(buoni[0]), 404);
  assert.ok(pubblicati.pubblica(lavoro, pr, buoni[0]).ok);
  assert.strictEqual(await apri(buoni[0]), 200);
  await st.go(`/studio/lavori/${lavoroA}/pratiche/${pr.id}/scarta`, { method: 'POST', body: new URLSearchParams({ _csrf: c }) });
  assert.strictEqual(await apri(buoni[0]), 404);
  const pag = (await st.go(`/studio/lavori/${lavoroA}`)).text;
  assert.match(pag, /id="scartate"[^]*CILA/);
  assert.ok(!new RegExp(`id="pratica-${pr.id}"`).test(pag));
  await st.go(`/studio/lavori/${lavoroA}/pratiche/${pr.id}/scarta`, { method: 'POST', body: new URLSearchParams({ _csrf: c, azione: 'ripristina' }) });
  const dopo = db.prepare('SELECT scartata, visibile FROM pratiche WHERE id = ?').get(pr.id);
  assert.deepStrictEqual([dopo.scartata, dopo.visibile], [0, 0]); // ripristinata ma privata
  db.prepare('UPDATE pratiche SET visibile = 1 WHERE id = ?').run(pr.id);
});

test('caso reale: integrazioni, doppioni firmati, email salvate e documento del geometra', async () => {
  const pubblicati = require('../src/pubblicati');
  const pratiche = require('../src/pratiche');
  const automazioni = require('../src/automazioni');
  const { PDFDocument, StandardFonts } = await (async () => { try { return require('pdf-lib'); } catch { return {}; } })();
  for (const f of ['Documento Geometra.pdf', 'CONSEGNA SCIA - Rossi.eml', 'Elaborati.zip']) assert.ok(pubblicati.sembraSensibile(`Presentazione/${f}`), f);
  assert.strictEqual(pratiche.nomeVisibile('006-SCIa prot.10912 del 07-07-2026'), 'SCIA prot.10912 del 07-07-2026');
  // Lavoro con presentazione SCIA, due integrazioni e doppioni .p7m
  const { Lavori: L } = require('../src/modelli');
  const id = Number(L.inserisci.run({ codice: 'R-1', titolo: 'Caso reale', descrizione: null, indirizzo: null, stato: 'In corso', cartella: 'R-1 Reale', data_inizio: null, data_fine: null, visibile: 1 }).lastInsertRowid);
  L.aggiungiCliente.run(id, Utenti.perEmail.get('anna@esempio.it').id);
  const base = path.join(process.env.ARCHIVIO_DIR, 'R-1 Reale', '006-SCIa prot.10912');
  for (const d of ['Presentazione', 'Integrazione Opere Strutturali', 'Integrazione L.13-89']) fs.mkdirSync(path.join(base, d), { recursive: true });
  for (const f of ['Tav.U.pdf', 'Tav.U.pdf.p7m', 'Modello SCIA.pdf', 'Modello SCIA.pdf.p7m', 'Solo firmato.pdf.p7m', 'Documento Geometra.pdf', 'CONSEGNA SCIA.eml']) fs.writeFileSync(path.join(base, 'Presentazione', f), '%PDF-1.4 x');
  // Ricevute come PDF veri (generati con il testo delle ricevute reali)
  const ricevuta = async (rel, righe) => {
    const pdfkit = require('pdfjs-dist/package.json'); // assicura che il lettore sia installato
    assert.ok(pdfkit);
    fs.writeFileSync(path.join(base, rel), creaPdf(righe));
  };
  await ricevuta('Ricevuta_Protocollo.PDF', ['Ricevuta di Protocollazione', 'CAVRIGLIA, li 07/07/2026', 'di un atto al protocollo comunale nella data odierna, alle ore 08:58 al numero 10912 avente come oggetto:']);
  await ricevuta('Integrazione Opere Strutturali/Ricevuta_2026_11391.PDF', ['Ricevuta di Protocollazione', 'CAVRIGLIA, li 14/07/2026', 'alle ore 10:02 al numero 11391 avente come oggetto:']);
  await ricevuta('Integrazione L.13-89/Ricevuta_2026_12148.PDF', ['Ricevuta di Protocollazione', 'CAVRIGLIA, li 28/07/2026', 'alle ore 15:34 al numero 12148 avente come oggetto:']);
  await ricevuta('Integrazione Opere Strutturali/deposito.pdf', ['Settore SISMICA', 'Data Avviso 08/07/2026', 'Attestazione di deposito progetto', 'Progetto n. 181576 Protocollo n. 20260050560']);
  await automazioni.scansionaRicevute(L.perId.get(id));
  const pr = db.prepare('SELECT * FROM pratiche WHERE lavoro_id = ?').get(id);
  const prop = db.prepare("SELECT * FROM proposte_stato WHERE pratica_id = ? AND stato_proposta = 'nuova' ORDER BY id").all(pr.id);
  assert.deepStrictEqual(prop.map((x) => [x.stato, x.protocollo, x.data]), [['Presentata', '10912', '2026-07-07']],
    'solo la presentazione resta da confermare; la ricevuta sismica dentro un\'integrazione non diventa una proposta');
  // Le integrazioni sono già registrate come tappe, senza toccare la presentazione
  const tp = db.prepare('SELECT fase, protocollo, data FROM pratiche_tappe WHERE pratica_id = ? ORDER BY data').all(pr.id);
  assert.deepStrictEqual(tp.map((t) => [t.fase, t.protocollo, t.data]), [['integrazione', '11391', '2026-07-14'], ['integrazione', '12148', '2026-07-28']]);
  db.prepare('UPDATE pratiche SET visibile = 1 WHERE id = ?').run(pr.id); // lo studio rende visibile la SCIA
  for (const x of prop) await automazioni.applicaStato(x.id, null, { email: false });
  const dopo = db.prepare('SELECT * FROM pratiche WHERE id = ?').get(pr.id);
  assert.strictEqual(dopo.protocollo, '10912', 'il protocollo della SCIA resta quello della presentazione');
  assert.strictEqual(dopo.stato, 'Presentata');
  const diario = db.prepare('SELECT testo FROM aggiornamenti WHERE lavoro_id = ? ORDER BY id').all(id).map((r) => r.testo);
  assert.ok(diario.some((t) => /presentata il 07\/07\/2026, protocollo n\. 10912/.test(t)));
  // Ricevute lette con regole vecchie: con regole nuove si rileggono, senza doppioni né nuove proposte di presentazione
  db.prepare('UPDATE file_letti SET regole = 0').run();
  await automazioni.scansionaRicevute(L.perId.get(id));
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM pratiche_tappe WHERE pratica_id = ?').get(pr.id).n, 2);
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM proposte_stato WHERE pratica_id = ? AND stato_proposta = 'nuova'").get(pr.id).n, 0);
  // Cosa vede il cliente nella presentazione
  db.prepare('UPDATE pratiche SET visibile = 1 WHERE id = ?').run(pr.id);
  const elenco = (await pratiche.conDocumenti(L.perId.get(id), { soloVisibili: true })).find((x) => x.id === pr.id).file.map((f) => f.nome).sort();
  assert.deepStrictEqual(elenco, ['Modello SCIA.pdf', 'Solo firmato.pdf.p7m', 'Tav.U.pdf']);
});

// PDF minimo con testo leggibile, senza librerie esterne
function creaPdf(righe) {
  const testo = righe.map((r, i) => `BT /F1 11 Tf 40 ${780 - i * 16} Td (${r.replace(/[()\\]/g, '')}) Tj ET`).join('\n');
  const oggetti = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(testo)} >>\nstream\n${testo}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const pos = [];
  oggetti.forEach((o, i) => { pos.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${oggetti.length + 1}\n0000000000 65535 f \n` + pos.map((p) => `${String(p).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${oggetti.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('visibilità delle cartelle: nuove cartelle private, lo studio sceglie quali mostrare', async () => {
  const pratiche = require('../src/pratiche');
  const { Lavori: L } = require('../src/modelli');
  const id = Number(L.inserisci.run({ codice: 'V-1', titolo: 'Scelta cartelle', descrizione: null, indirizzo: null, stato: 'In corso', cartella: 'V-1 Scelta', data_inizio: null, data_fine: null, visibile: 1 }).lastInsertRowid);
  const anna = Utenti.perEmail.get('anna@esempio.it');
  L.aggiungiCliente.run(id, anna.id);
  for (const c of ['005-Nota Tecnica', '006-SCIA']) {
    fs.mkdirSync(path.join(process.env.ARCHIVIO_DIR, 'V-1 Scelta', c, 'Presentazione'), { recursive: true });
    fs.writeFileSync(path.join(process.env.ARCHIVIO_DIR, 'V-1 Scelta', c, 'Presentazione', `${c}.pdf`), '%PDF-1.4');
  }
  const elenco = await pratiche.sincronizza(L.perId.get(id));
  assert.ok(elenco.every((p) => !p.visibile), 'anche i tipi riconosciuti (SCIA) nascono privati');
  db.prepare('DELETE FROM tentativi_accesso').run();
  const a = browser();
  await a.accedi('anna@esempio.it', PW);
  assert.ok(!(await a.go(`/area/lavori/${id}`)).text.includes('006-SCIA.pdf'));
  const s = browser();
  await s.accedi('studio@esempio.it', PW);
  const scia = elenco.find((p) => p.cartella === '006-SCIA');
  await s.post(`/studio/lavori/${id}/pratiche-visibili`, { visibili: String(scia.id) }, { da: `/studio/lavori/${id}` });
  const t = (await a.go(`/area/lavori/${id}`)).text;
  assert.ok(t.includes('006-SCIA.pdf') && !t.includes('Nota Tecnica'));
  // Tolta la spunta: torna privata
  await s.post(`/studio/lavori/${id}/pratiche-visibili`, {}, { da: `/studio/lavori/${id}` });
  assert.ok(!(await a.go(`/area/lavori/${id}`)).text.includes('006-SCIA.pdf'));
  // Il cliente non può cambiare la visibilità
  assert.strictEqual((await a.post(`/studio/lavori/${id}/pratiche-visibili`, { visibili: String(scia.id) }, { da: `/area/lavori/${id}` })).status, 403);
});

test('cartella Catasto: cartella di base senza stato, né per lo studio né per il cliente', async () => {
  const { eBase } = require('../src/pratiche');
  assert.ok(eBase('Catasto') && eBase('02 - Catasto') && eBase('Catasto e visure'));
  assert.ok(!eBase('DOCFA') && !eBase('Pratiche catastali') && !eBase('SCIA'));
  const dir = path.join(process.env.ARCHIVIO_DIR, 'A-1 Anna', 'Catasto');
  fs.mkdirSync(dir, { recursive: true });
  const s = browser();
  await s.accedi('studio@esempio.it', PW);
  const pag = (await s.go(`/studio/lavori/${lavoroA}`)).text;
  const pr = db.prepare("SELECT * FROM pratiche WHERE lavoro_id = ? AND cartella = 'Catasto'").get(lavoroA);
  assert.ok(pr);
  const blocco = pag.slice(pag.indexOf(`id="pratica-${pr.id}"`), pag.indexOf('</details>', pag.indexOf(`id="pratica-${pr.id}"`)));
  assert.match(blocco, /Cartella di base del lavoro/);
  assert.ok(!/name="stato"|name="protocollo"|Da fare/.test(blocco), 'nessuno stato per la cartella Catasto');
  // Anche forzando il modulo lo stato non cambia
  await s.post(`/studio/lavori/${lavoroA}/pratiche/${pr.id}`, { stato: 'Completata', protocollo: '123', data: '2026-01-01', visibile: '1' }, { da: `/studio/lavori/${lavoroA}` });
  const dopo = db.prepare('SELECT * FROM pratiche WHERE id = ?').get(pr.id);
  assert.strictEqual(dopo.stato, pr.stato);
  assert.strictEqual(dopo.protocollo, null);
  assert.strictEqual(dopo.visibile, 1);
  const a = browser();
  await a.accedi('anna@esempio.it', PW);
  const area = (await a.go(`/area/lavori/${lavoroA}`)).text;
  const b2 = area.slice(area.indexOf(`id="pratica-${pr.id}"`), area.indexOf('</article>', area.indexOf(`id="pratica-${pr.id}"`)));
  assert.match(b2, /Catasto/);
  assert.ok(!/badge stato-|pratica-stato/.test(b2), 'il cliente non vede uno stato per il Catasto');
});
