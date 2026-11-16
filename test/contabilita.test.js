'use strict';
/** Contabilità: calcoli, PDF e riservatezza (solo admin). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-conta-'));
process.env.ARCHIVIO_DIR = path.join(tmp, 'lavori');
process.env.DATI_DIR = path.join(tmp, 'app');
fs.mkdirSync(process.env.ARCHIVIO_DIR, { recursive: true });

const app = require('../src/server');
const auth = require('../src/auth');
const c = require('../src/contabilita');
const { Utenti } = require('../src/modelli');

let base; let server;
const PW = 'PasswordSicura123';

function browser() {
  let cookie = '';
  return {
    async go(p, opt = {}) {
      const r = await fetch(base + p, { redirect: 'manual', ...opt, headers: { ...(opt.headers || {}), cookie } });
      const sc = r.headers.getSetCookie();
      if (sc.length) cookie = sc.map((s) => s.split(';')[0]).join('; ');
      return { status: r.status, loc: r.headers.get('location'), buf: Buffer.from(await r.arrayBuffer()), tipo: r.headers.get('content-type') };
    },
    async csrf(p) { return ((await this.go(p)).buf.toString().match(/name="_csrf" value="([^"]+)"/) || [])[1] || ''; },
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

test('importi: formati italiani e valori non validi', () => {
  assert.strictEqual(c.importo('1.234,56'), 123456);
  assert.strictEqual(c.importo('450'), 45000);
  assert.strictEqual(c.importo('12,5 €'), 1250);
  assert.strictEqual(c.importo('abc'), null);
  assert.strictEqual(c.importo(''), null);
});

test('calcolo regime ordinario: cassa 5%, IVA 22% sul compenso + cassa, spese e bollo fuori IVA', () => {
  const t = c.calcola({ voci: [{ c: 145000 }], spese: [{ c: 10000 }], cassa_pct: 5, iva_pct: 22, sostituto: 0 });
  assert.deepStrictEqual([t.cassa, t.imponibile, t.iva, t.bollo, t.totale, t.ritenuta], [7250, 152250, 33495, 200, 195945, 0]);
});

test('bollo solo sopra 77,47 € di spese; ritenuta 20% solo sul compenso se sostituto', () => {
  assert.strictEqual(c.calcola({ voci: [{ c: 10000 }], spese: [{ c: 7747 }], sostituto: 0 }).bollo, 0);
  assert.strictEqual(c.calcola({ voci: [{ c: 10000 }], spese: [{ c: 7748 }], sostituto: 0 }).bollo, 200);
  const t = c.calcola({ voci: [{ c: 100000 }], spese: [], sostituto: 1 });
  assert.strictEqual(t.ritenuta, 20000);
  assert.strictEqual(t.netto, t.totale - 20000);
});

test('righe vuote scartate e arrotondamento al centesimo', () => {
  assert.deepStrictEqual(c.righe(['A', '', 'B'], ['10,00', '', '5,005x']), [{ d: 'A', c: 1000 }, { d: 'B', c: 0 }]);
  assert.strictEqual(c.calcola({ voci: [{ c: 333 }], spese: [] }).cassa, 17);
});

test('solo l\'admin vede la contabilità: cliente e visitatore no', async () => {
  const anonimo = browser();
  assert.notStrictEqual((await anonimo.go('/studio/contabilita')).status, 200);
  const cli = browser();
  await cli.post('/accedi', { email: 'anna@esempio.it', password: PW }, '/accedi');
  const r = await cli.go('/studio/contabilita');
  assert.notStrictEqual(r.status, 200);
  assert.ok(!/Da incassare/.test(r.buf.toString()));
});

test('l\'admin crea una bozza, la rivede e scarica un PDF valido', async () => {
  const b = browser();
  await b.post('/accedi', { email: 'studio@esempio.it', password: PW }, '/accedi');
  const r = await b.post('/studio/contabilita', {
    dest_nome: 'Mario Rossi', dest_email: 'mario@esempio.it', oggetto: 'Prova', data: '2026-11-16',
    voce_desc: 'SCIA', voce_importo: '1.000,00', spesa_desc: 'Diritti', spesa_importo: '100,00', cassa_pct: '5', iva_pct: '22',
  }, '/studio/contabilita/nuova');
  assert.strictEqual(r.status, 302);
  assert.match(r.loc, /\/studio\/contabilita\/\d+/);
  const pagina = (await b.go(r.loc)).buf.toString();
  assert.match(pagina, /2026\/P-001/);
  assert.match(pagina, /1\.383,00|1383,00/);
  const pdf = await b.go(`${r.loc}/notula.pdf`);
  assert.strictEqual(pdf.status, 200);
  assert.strictEqual(pdf.buf.subarray(0, 5).toString(), '%PDF-');
  const elenco = (await b.go('/studio/contabilita')).buf.toString();
  assert.match(elenco, /Mario Rossi/);
  // senza destinatario non salva
  const male = await b.post('/studio/contabilita', { dest_nome: '', voce_desc: 'x', voce_importo: '1' }, '/studio/contabilita/nuova');
  assert.strictEqual(male.status, 200);
});

test('senza casella amministrazione l\'invio non parte e la bozza resta bozza', async () => {
  const b = browser();
  await b.post('/accedi', { email: 'studio@esempio.it', password: PW }, '/accedi');
  const id = c.crea({ lavoro_id: null, dest_nome: 'X', dest_indirizzo: '', dest_cf: '', dest_email: 'x@esempio.it', oggetto: '', data: '2026-11-16',
    voci: JSON.stringify([{ d: 'a', c: 100 }]), spese: '[]', cassa_pct: 5, iva_pct: 22, sostituto: 0, note: '' });
  const r = await b.post(`/studio/contabilita/${id}/invia`, {}, `/studio/contabilita/${id}`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual(c.Q.perId.get(id).stato, 'bozza');
});
