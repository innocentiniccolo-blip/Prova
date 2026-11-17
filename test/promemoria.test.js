'use strict';
/** Promemoria alle imprese per i documenti in scadenza (dati inventati). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-promemoria-'));
process.env.ARCHIVIO_DIR = path.join(tmp, 'lavori');
process.env.DATI_DIR = path.join(tmp, 'app');
process.env.POSTA_CARTELLA = path.join(tmp, 'posta');
fs.mkdirSync(process.env.ARCHIVIO_DIR, { recursive: true });

const app = require('../src/server');
const auth = require('../src/auth');
const imprese = require('../src/imprese');
const { Utenti } = require('../src/modelli');

const PW = 'PasswordSicura123';
let base; let server;
const iso = (g) => { const d = new Date(); d.setDate(d.getDate() + g); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const nuova = (dati) => Number(imprese.Q.inserisci.run({ ragione_sociale: 'Edile Prova srl', piva: null, sede: null, pec: null, email: null, telefono: null, autonomo: 0, nota: null, ...dati }).lastInsertRowid);
const posta = () => (fs.existsSync(process.env.POSTA_CARTELLA) ? fs.readdirSync(process.env.POSTA_CARTELLA) : []);

function browser() {
  let cookie = '';
  return {
    async go(p, opt = {}) {
      const r = await fetch(base + p, { redirect: 'manual', ...opt, headers: { ...(opt.headers || {}), cookie } });
      const sc = r.headers.getSetCookie();
      if (sc.length) cookie = sc.map((s) => s.split(';')[0]).join('; ');
      return { status: r.status, loc: r.headers.get('location'), testo: await r.text() };
    },
    async csrf(p) { return ((await this.go(p)).testo.match(/name="_csrf" value="([^"]+)"/) || [])[1] || ''; },
    async post(p, dati, da) { return this.go(p, { method: 'POST', body: new URLSearchParams({ ...dati, _csrf: await this.csrf(da) }) }); },
  };
}

test.before(async () => {
  const h = await auth.hashPassword(PW);
  Utenti.inserisci.run('studio@esempio.it', h, 'Studio', null, 'admin');
  Utenti.inserisci.run('anna@esempio.it', h, 'Anna', null, 'cliente');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test('indirizzo: email se presente, altrimenti PEC', () => {
  assert.strictEqual(imprese.destinatario({ email: 'a@esempio.it', pec: 'p@pec.esempio.it' }), 'a@esempio.it');
  assert.strictEqual(imprese.destinatario({ email: null, pec: 'p@pec.esempio.it' }), 'p@pec.esempio.it');
  assert.strictEqual(imprese.destinatario({}), '');
});

test('un documento o tutti: testo chiaro, senza link, e registro degli invii', async () => {
  const id = nuova({ email: 'ufficio@edileprova.it' });
  await imprese.salvaDocumento(id, { tipo: 'durc', rilascio: iso(-110) }); // scade tra 10 giorni
  await imprese.salvaDocumento(id, { tipo: 'visura', rilascio: iso(-10) }); // valida
  const inviate = [];
  const finto = async (m) => { inviate.push(m); return true; };
  const voci = imprese.daSollecitare(id).map((v) => v.tipo);
  assert.deepStrictEqual(voci, ['durc', 'patente']); // DURC in scadenza, patente mancante
  const uno = await imprese.inviaPromemoria(imprese.Q.perId.get(id), 'durc', finto);
  assert.deepStrictEqual([uno.ok, uno.n, inviate[0].a], [true, 1, 'ufficio@edileprova.it']);
  assert.match(inviate[0].oggetto, /DURC/);
  assert.match(inviate[0].testo, /DURC: scade il/);
  assert.ok(!/patente/i.test(inviate[0].testo));
  assert.ok(!/https?:\/\//.test(inviate[0].testo));
  const tutti = await imprese.inviaPromemoria(imprese.Q.perId.get(id), '', finto);
  assert.strictEqual(tutti.n, 2);
  assert.match(inviate[1].testo, /Patente a crediti: non ci risulta/);
  assert.ok(imprese.daSollecitare(id).every((v) => v.ultimo));
});

test('senza indirizzo o con documenti in regola non parte niente', async () => {
  const senza = nuova({});
  const inviate = [];
  const r = await imprese.inviaPromemoria(imprese.Q.perId.get(senza), '', async (m) => { inviate.push(m); return true; });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(inviate.length, 0);
  const ok = nuova({ email: 'ok@esempio.it' });
  await imprese.salvaDocumento(ok, { tipo: 'durc', rilascio: iso(-5) });
  await imprese.salvaDocumento(ok, { tipo: 'visura', rilascio: iso(-5) });
  await imprese.salvaDocumento(ok, { tipo: 'patente', crediti: 30 });
  assert.strictEqual((await imprese.inviaPromemoria(imprese.Q.perId.get(ok), 'durc', async () => true)).ok, false);
});

test('dal pannello: lo studio invia con un clic, il cliente no; email salvata nella scheda', async () => {
  const st = browser();
  await st.post('/accedi', { email: 'studio@esempio.it', password: PW }, '/accedi');
  const id = nuova({ pec: 'edile@pec.esempio.it' });
  await st.post(`/studio/imprese/${id}`, { ragione_sociale: 'Edile Prova srl', email: 'cantiere@edileprova.it', pec: 'edile@pec.esempio.it' }, `/studio/imprese/${id}`);
  assert.strictEqual(imprese.Q.perId.get(id).email, 'cantiere@edileprova.it');
  const pagina = (await st.go(`/studio/imprese/${id}`)).testo;
  assert.match(pagina, /Invia promemoria per tutti i documenti \(3\)/);
  const prima = posta().length;
  const r = await st.post(`/studio/imprese/${id}/promemoria`, { tipo: 'durc' }, `/studio/imprese/${id}`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual(posta().length, prima + 1);
  assert.match(posta().at(-1), /cantiere@edileprova\.it/);
  assert.match((await st.go(`/studio/imprese/${id}`)).testo, /Promemoria inviato il/);

  const cli = browser();
  await cli.post('/accedi', { email: 'anna@esempio.it', password: PW }, '/accedi');
  const csrf = await cli.csrf('/area');
  await cli.go(`/studio/imprese/${id}/promemoria`, { method: 'POST', body: new URLSearchParams({ _csrf: csrf }) });
  assert.strictEqual(posta().length, prima + 1);
});
