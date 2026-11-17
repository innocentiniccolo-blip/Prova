'use strict';
/** Chiusura automatica della sessione per inattività. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-inattivita-'));
process.env.ARCHIVIO_DIR = path.join(tmp, 'lavori');
process.env.DATI_DIR = path.join(tmp, 'app');
fs.mkdirSync(process.env.ARCHIVIO_DIR, { recursive: true });

const app = require('../src/server');
const auth = require('../src/auth');
const { db, Utenti } = require('../src/modelli');

let base; let server; let cookie = '';
const PW = 'PasswordSicura123';

async function go(p, opt = {}) {
  const r = await fetch(base + p, { redirect: 'manual', ...opt, headers: { ...(opt.headers || {}), cookie } });
  const sc = r.headers.getSetCookie();
  if (sc.length) cookie = sc.map((s) => s.split(';')[0]).join('; ');
  return { status: r.status, loc: r.headers.get('location'), text: await r.text() };
}
const csrf = async () => ((await go('/accedi')).text.match(/name="_csrf" value="([^"]+)"/) || [])[1];
const sidDalCookie = () => decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];

test.before(async () => {
  Utenti.inserisci.run('studio@esempio.it', await auth.hashPassword(PW), 'Studio', null, 'admin');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test('dopo 30 minuti senza attività la sessione si chiude e serve di nuovo l\'accesso', async () => {
  const tok = await csrf();
  const r = await go('/accedi', { method: 'POST', body: new URLSearchParams({ email: 'studio@esempio.it', password: PW, _csrf: tok }) });
  assert.strictEqual(r.status, 302);
  assert.strictEqual((await go('/studio')).status, 200, 'attiva subito dopo il login');
  // Simula mezz'ora di inattività
  const sid = sidDalCookie();
  const dati = JSON.parse(db.prepare('SELECT dati FROM sessioni WHERE sid = ?').get(sid).dati);
  dati.ultimaAttivita = Date.now() - 31 * 60 * 1000;
  db.prepare('UPDATE sessioni SET dati = ? WHERE sid = ?').run(JSON.stringify(dati), sid);
  const scaduta = await go('/studio');
  assert.strictEqual(scaduta.status, 302);
  assert.strictEqual(scaduta.loc, '/accedi?scaduta=1');
  assert.match((await go('/accedi?scaduta=1')).text, /inattività/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM sessioni WHERE sid = ?').get(sid).n, 0, 'sessione cancellata dal database');
  assert.strictEqual((await go('/studio')).loc, '/accedi', 'il vecchio cookie non serve più');
});

test('usando il sito l\'attività si rinnova e la sessione resta aperta', async () => {
  const tok = await csrf();
  await go('/accedi', { method: 'POST', body: new URLSearchParams({ email: 'studio@esempio.it', password: PW, _csrf: tok }) });
  for (let i = 0; i < 3; i++) {
    const sid = sidDalCookie();
    const dati = JSON.parse(db.prepare('SELECT dati FROM sessioni WHERE sid = ?').get(sid).dati);
    dati.ultimaAttivita = Date.now() - 20 * 60 * 1000; // 20 minuti: ancora dentro il limite
    db.prepare('UPDATE sessioni SET dati = ? WHERE sid = ?').run(JSON.stringify(dati), sid);
    assert.strictEqual((await go('/studio')).status, 200, `giro ${i}`);
  }
});
