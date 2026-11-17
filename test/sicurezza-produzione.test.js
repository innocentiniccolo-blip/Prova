'use strict';
/**
 * Prove con la configurazione del server vero: HTTPS dietro il proxy, cookie sicuri,
 * posta inviata davvero (a un finto server SMTP locale).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-prod-'));
const PORTA_SMTP = 20000 + (process.pid % 20000);
Object.assign(process.env, {
  NODE_ENV: 'production', ARCHIVIO_DIR: path.join(tmp, 'lavori'), DATI_DIR: path.join(tmp, 'app'),
  URL_PUBBLICO: 'https://area.esempio.it', SOLO_AREA: 'true', COOKIE_SECURE: 'true', TRUST_PROXY: 'true',
  SMTP_HOST: '127.0.0.1', SMTP_PORT: String(PORTA_SMTP), SMTP_USER: '', MAIL_FROM: 'studio@esempio.it',
});
fs.mkdirSync(process.env.ARCHIVIO_DIR, { recursive: true });

// Finto server di posta: raccoglie i messaggi ricevuti
const posta = [];
const smtp = net.createServer((s) => {
  let dati = ''; let inData = false; let corpo = '';
  s.write('220 finto\r\n');
  s.on('data', (d) => {
    dati += d;
    let i;
    while ((i = dati.indexOf('\r\n')) >= 0) {
      const riga = dati.slice(0, i); dati = dati.slice(i + 2);
      if (inData) {
        if (riga === '.') { inData = false; posta.push(corpo); corpo = ''; s.write('250 ok\r\n'); } else corpo += riga + '\n';
      } else if (/^EHLO|^HELO/i.test(riga)) s.write('250 finto\r\n');
      else if (/^DATA/i.test(riga)) { inData = true; s.write('354 vai\r\n'); }
      else if (/^QUIT/i.test(riga)) { s.write('221 ciao\r\n'); s.end(); }
      else s.write('250 ok\r\n');
    }
  });
  s.on('error', () => {});
});
const testoPosta = (m) => m.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const attendiPosta = async (n) => { for (let i = 0; i < 100 && posta.length < n; i++) await new Promise((r) => setTimeout(r, 30)); };

let app; let auth; let Utenti; let db; let base; let server;
const PW = 'PasswordSicura123';

function browser(ipCliente = '203.0.113.5') {
  let cookie = '';
  return {
    get cookie() { return cookie; }, set cookie(c) { cookie = c; },
    async go(p, opt = {}) {
      const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-for': ipCliente, ...(opt.headers || {}), cookie };
      const r = await fetch(base + p, { redirect: 'manual', ...opt, headers });
      const sc = r.headers.getSetCookie();
      if (sc.length) cookie = sc.map((x) => x.split(';')[0]).join('; ');
      return { status: r.status, loc: r.headers.get('location'), headers: r.headers, setCookie: sc.join(';'), text: await r.text() };
    },
    async post(p, dati, da = '/accedi', extra = {}) {
      const tok = ((await this.go(da)).text.match(/name="_csrf" value="([^"]+)"/) || [])[1] || '';
      return this.go(p, { method: 'POST', body: new URLSearchParams({ ...dati, _csrf: tok }), ...extra });
    },
    accedi(email, password) { return this.post('/accedi', { email, password }); },
  };
}

test.before(async () => {
  await new Promise((r) => smtp.listen(PORTA_SMTP, '127.0.0.1', r));
  app = require('../src/server');
  auth = require('../src/auth');
  ({ Utenti, db } = require('../src/modelli'));
  const h = await auth.hashPassword(PW);
  Utenti.inserisci.run('studio@esempio.it', h, 'Studio', null, 'admin');
  Utenti.inserisci.run('carla@esempio.it', h, 'Carla', null, 'cliente');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server && server.close(); smtp.close(); });

test('cookie di sessione: Secure, HttpOnly, SameSite; HSTS attivo', async () => {
  const r = await browser().go('/accedi');
  assert.match(r.setCookie, /Secure/i);
  assert.match(r.setCookie, /HttpOnly/i);
  assert.match(r.setCookie, /SameSite=Lax/i);
  assert.match(r.headers.get('strict-transport-security') || '', /max-age=31536000/);
});

test('la sessione cambia identificativo al login e muore al logout', async () => {
  const b = browser();
  await b.go('/accedi');
  const prima = b.cookie;
  assert.strictEqual((await b.accedi('carla@esempio.it', PW)).loc, '/area');
  const dopo = b.cookie;
  assert.notStrictEqual(prima, dopo, 'identificativo rigenerato (niente session fixation)');
  // Il vecchio cookie non dà accesso
  const vecchio = browser(); vecchio.cookie = prima;
  assert.strictEqual((await vecchio.go('/area')).status, 302);
  // Logout: il cookie rubato dopo l'uscita non funziona più
  await b.post('/esci', {}, '/area');
  const rubato = browser(); rubato.cookie = dopo;
  assert.strictEqual((await rubato.go('/area')).status, 302);
});

test('cookie di sessione manomesso o inventato: nessun accesso', async () => {
  for (const c of ['studio.sid=s%3Ainventato.firmafalsa', 'studio.sid=1', 'studio.sid=' + 'A'.repeat(4000)]) {
    const b = browser(); b.cookie = c;
    const r = await b.go('/studio');
    assert.strictEqual(r.status, 302);
  }
});

test('falsificare X-Forwarded-For non aggira il blocco', async () => {
  db.prepare('DELETE FROM tentativi_accesso').run();
  // Il proxy aggiunge sempre in coda l'indirizzo vero: chi attacca può solo inventare quelli prima
  for (let i = 0; i < 5; i++) await browser(`10.0.0.${i}, 198.51.100.77`).accedi('carla@esempio.it', 'no' + i);
  const r = await browser('1.2.3.4, 198.51.100.77').accedi('carla@esempio.it', PW);
  assert.match(r.text, /Troppi tentativi/);
  await attendiPosta(1);
});

test('avviso di blocco: arriva davvero per email allo studio, con indirizzo IP reale', async () => {
  await attendiPosta(1);
  assert.strictEqual(posta.length, 1);
  const m = testoPosta(posta[0]);
  assert.match(m, /To: studio@esempio\.it/);
  assert.match(m, /Subject: Accesso bloccato: carla@esempio\.it/);
  assert.match(m, /cliente: Carla/);
  assert.match(m, /Indirizzo IP: 198\.51\.100\.77/);
  assert.match(m, /https:\/\/area\.esempio\.it\/studio/);
  assert.ok(!m.includes(PW), 'nessuna password nelle email');
});

test('password dimenticata: stessa risposta per email note e ignote, link solo sul dominio vero, monouso', async () => {
  posta.length = 0;
  const b = browser('192.0.2.10');
  const ignota = await b.post('/password-dimenticata', { email: 'nessuno@esempio.it' }, '/password-dimenticata');
  // Host falsificato: il link nell'email non deve mai puntare altrove
  const nota = await b.post('/password-dimenticata', { email: 'carla@esempio.it' }, '/password-dimenticata', { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
  assert.strictEqual(ignota.status, nota.status);
  const pulisci = (t) => t.replace(/name="_csrf" value="[^"]+"/g, '');
  assert.strictEqual(pulisci(ignota.text), pulisci(nota.text));
  await attendiPosta(1);
  assert.strictEqual(posta.length, 1, 'email solo per l\'account esistente');
  const m = testoPosta(posta[0]);
  assert.ok(!m.includes('evil.example'));
  const link = m.match(/https:\/\/area\.esempio\.it(\/imposta-password\/[A-Za-z0-9_-]+)/)[1];
  // Nuova password: il link funziona una volta sola, la vecchia password non vale più, il blocco è tolto
  const NUOVA = 'NuovaPassword456';
  const r = await b.post(link, { nuova: NUOVA, conferma: NUOVA }, link);
  assert.strictEqual(r.loc, '/accedi');
  assert.strictEqual((await b.go(link)).status, 410);
  assert.strictEqual((await browser('192.0.2.10').post(link, { nuova: 'AltraPassword789', conferma: 'AltraPassword789' }, '/accedi')).status, 410);
  assert.strictEqual((await browser('192.0.2.11').accedi('carla@esempio.it', PW)).status, 401);
  assert.strictEqual((await browser('198.51.100.77').accedi('carla@esempio.it', NUOVA)).loc, '/area', 'il cambio password toglie il blocco');
  // Link inventati
  for (const t of ['abc', 'A'.repeat(43), '../../etc/passwd', 'A'.repeat(500)]) {
    assert.ok([404, 410].includes((await b.go('/imposta-password/' + encodeURIComponent(t))).status), t);
  }
});

test('richieste di reimpostazione: massimo 5 all\'ora per email', async () => {
  const b = browser('192.0.2.50');
  let ultimo;
  for (let i = 0; i < 6; i++) ultimo = await b.post('/password-dimenticata', { email: 'studio@esempio.it' }, '/password-dimenticata');
  assert.strictEqual(ultimo.status, 429);
});

test('primo avvio non più disponibile dopo la creazione dello studio', async () => {
  const r = await browser().go('/configura');
  assert.strictEqual(r.status, 302);
});

test('email al cliente: solo per il cambio di stato, con stato, data e protocollo', async () => {
  const { Lavori } = require('../src/modelli');
  const pratiche = require('../src/pratiche');
  db.prepare('DELETE FROM tentativi_accesso').run();
  const carla = Utenti.perEmail.get('carla@esempio.it');
  const id = Number(Lavori.inserisci.run({ codice: 'E-1', titolo: 'Lavoro email', descrizione: null, indirizzo: null, stato: 'In corso', cartella: 'E-1 Email', data_inizio: null, data_fine: null, visibile: 1 }).lastInsertRowid);
  Lavori.aggiungiCliente.run(id, carla.id);
  fs.mkdirSync(path.join(process.env.ARCHIVIO_DIR, 'E-1 Email', 'CILA'), { recursive: true });
  await pratiche.sincronizza(Lavori.perId.get(id));
  const pr = db.prepare('SELECT * FROM pratiche WHERE lavoro_id = ?').get(id);
  db.prepare('UPDATE pratiche SET visibile = 1 WHERE id = ?').run(pr.id);
  const s = browser('192.0.2.200');
  await s.accedi('studio@esempio.it', PW);
  const pag = `/studio/lavori/${id}`;
  // Caricare un documento non manda email, anche se si prova a chiederla
  posta.length = 0;
  const fd = new FormData();
  fd.append('_csrf', ((await s.go(pag)).text.match(/name="_csrf" value="([^"]+)"/) || [])[1]);
  fd.append('pratica', String(pr.id)); fd.append('pubblica', '1'); fd.append('email', '1');
  fd.append('file', new Blob(['%PDF-1.4 x']), 'Tavola.pdf');
  await s.go(`${pag}/documenti`, { method: 'POST', body: fd });
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(posta.length, 0, 'nessuna email per i documenti');
  // Cambio di stato: email con stato, data e protocollo, senza la nota interna
  await s.post(`${pag}/pratiche/${pr.id}`, { stato: 'Presentata', data: '2026-11-10', protocollo: '18405', nota: 'nota da non spedire', visibile: '1', email: '1' }, pag);
  await attendiPosta(1);
  assert.strictEqual(posta.length, 1);
  const m = testoPosta(posta[0]);
  assert.match(m, /To: carla@esempio\.it/);
  assert.match(m, /Subject: =\?UTF-8\?Q\?Aggiornamento_pratica:_CILA/);
  assert.match(m, /Stato: Presentata/);
  assert.match(m, /Data: 10\/11\/2026/);
  assert.match(m, /Protocollo n\.: 18405/);
  assert.ok(!m.includes('nota da non spedire'));
  // Salvare di nuovo senza cambiare stato, data o protocollo: nessuna seconda email
  await s.post(`${pag}/pratiche/${pr.id}`, { stato: 'Presentata', data: '2026-11-10', protocollo: '18405', nota: 'altra nota', visibile: '1', email: '1' }, pag);
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(posta.length, 1);
});
