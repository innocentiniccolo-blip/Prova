'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cruscotto-'));
process.env.DATI_DIR = tmp;
delete process.env.ANTHROPIC_API_KEY;

const F = require('../src/formato');
const ai = require('../src/ai');
const app = require('../src/server');

test('importi in euro', () => {
  assert.strictEqual(F.euroInCentesimi('1.234,56'), 123456);
  assert.strictEqual(F.euroInCentesimi('€ 800'), 80000);
  assert.strictEqual(F.euroInCentesimi('1.200'), 120000);
  assert.strictEqual(F.euroInCentesimi('1200.5'), 120050);
  assert.strictEqual(F.euroInCentesimi('abc'), null);
  assert.strictEqual(F.euroInCentesimi(''), null);
  assert.match(F.euro(123456), /1\.234,56/);
  assert.strictEqual(F.centesimiInTesto(150000), '1500,00');
});

test('numeri per WhatsApp', () => {
  assert.strictEqual(F.telefonoWhatsapp('339 856 1221'), '393398561221');
  assert.strictEqual(F.telefonoWhatsapp('+39 339-8561221'), '393398561221');
  assert.strictEqual(F.telefonoWhatsapp('0039 3398561221'), '393398561221');
  assert.strictEqual(F.telefonoWhatsapp('392 1234567'), '393921234567'); // cellulare che inizia per 39
  assert.strictEqual(F.telefonoWhatsapp('055 912345'), '39055912345');
  assert.strictEqual(F.telefonoWhatsapp('123'), null);
  assert.match(F.linkWhatsapp('3398561221', 'Buongiorno, è pronta'), /^https:\/\/wa\.me\/393398561221\?text=Buongiorno%2C%20%C3%A8%20pronta$/);
});

test('link email', () => {
  assert.strictEqual(F.linkEmail('mario@rossi.it', 'SCIA', 'Riga 1\nRiga 2'), 'mailto:mario@rossi.it?subject=SCIA&body=Riga%201%0D%0ARiga%202');
  assert.strictEqual(F.linkEmail('non-valida', 'x', 'y'), null);
  assert.strictEqual(F.linkEmail('a@b.it, c@d.it', 'x', 'y'), null);
});

test('urgenza delle scadenze', () => {
  const rif = '2026-11-23';
  assert.strictEqual(F.urgenza('2026-11-20', rif).classe, 'scaduta');
  assert.strictEqual(F.urgenza('2026-11-23', rif).testo, 'oggi');
  assert.strictEqual(F.urgenza('2026-11-28', rif).classe, 'urgente');
  assert.strictEqual(F.urgenza('2026-12-15', rif).classe, 'vicina');
  assert.strictEqual(F.piuGiorni('2026-12-31', 1), '2027-01-01');
});

test('la scheda per l\'AI contiene solo i dati della pratica', () => {
  const s = ai.schedaPratica({
    canale: 'whatsapp', destinatario: 'Mario Rossi',
    pratica: { commessa: '2026-001', indirizzo: 'Via Roma 1', cliente_nome: 'Mario Rossi', tipo: 'SCIA', ente: 'Comune di Montevarchi', stato: 'Presentata', protocollo: '1234', data_protocollo: '2026-11-02', onorario_cent: 150000, incassato_cent: 50000 },
    scadenze: [{ data: '2026-12-01', descrizione: 'Integrazioni', fatta: 0 }, { data: '2026-10-01', descrizione: 'Vecchia', fatta: 1 }],
    attivita: [{ testo: 'Chiedere visura', fatta: 0 }],
  });
  assert.match(s, /SCIA presso Comune di Montevarchi/);
  assert.match(s, /Commessa dello studio: 2026-001/);
  assert.match(s, /Protocollo: n\. 1234 del 2026-11-02/);
  assert.match(s, /da saldare: 1\.000,00/);
  assert.match(s, /Integrazioni/);
  assert.doesNotMatch(s, /Vecchia/);
  assert.match(s, /Chiedere visura/);
});

// ---------- Prova completa via HTTP ----------
function client(base) {
  let cookie = '';
  return async (url, { method = 'GET', form, json, headers = {} } = {}) => {
    const h = { ...headers, cookie };
    let body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const r = await fetch(base + url, { method, headers: h, body, redirect: 'manual' });
    const sc = r.headers.getSetCookie();
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const text = await r.text();
    return { status: r.status, location: r.headers.get('location'), text };
  };
}
const csrfDa = (html) => html.match(/name="csrf" content="([^"]+)"/)[1];

test('flusso completo: cliente, pratica, scadenze, attività, incassi, messaggi', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((ok) => server.once('listening', ok));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const vai = client(base);

  let r = await vai('/');
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /Cruscotto/);
  const csrf = csrfDa(r.text);

  // Senza token il modulo viene rifiutato
  r = await vai('/pratiche', { method: 'POST', form: { tipo: 'SCIA' } });
  assert.strictEqual(r.status, 403);

  // Validazione
  r = await vai('/pratiche', { method: 'POST', form: { _csrf: csrf, tipo: '' } });
  assert.strictEqual(r.status, 400);

  // Pratica con cliente nuovo creato al volo
  r = await vai('/pratiche', { method: 'POST', form: { _csrf: csrf, cliente_id: '', nuovo_cliente_nome: 'Mario Rossi', nuovo_cliente_telefono: '339 1234567', nuovo_cliente_email: 'mario@rossi.it', commessa: '2026-014', indirizzo: 'Via Roma 12, Montevarchi', tipo: 'SCIA', ente: 'Comune di Montevarchi', stato: 'Presentata', protocollo: '4567', data_protocollo: '2026-11-02', onorario: '1.500,00' } });
  assert.strictEqual(r.status, 302);
  const praticaUrl = r.location;
  assert.match(praticaUrl, /^\/pratiche\/\d+$/);

  r = await vai('/clienti');
  assert.match(r.text, /Mario Rossi/);
  const clienteUrl = r.text.match(/href="(\/clienti\/\d+)"/)[1];

  const ieri = F.piuGiorni(F.oggi(), -1);
  await vai(`${praticaUrl}/scadenze`, { method: 'POST', form: { _csrf: csrf, descrizione: 'Presentare integrazioni', data: ieri } });
  await vai(`${praticaUrl}/attivita`, { method: 'POST', form: { _csrf: csrf, testo: 'Chiedere visura catastale' } });
  await vai(`${praticaUrl}/incassi`, { method: 'POST', form: { _csrf: csrf, importo: '500', data: F.oggi(), descrizione: 'Acconto' } });

  r = await vai(praticaUrl);
  assert.match(r.text, /Presentare integrazioni/);
  assert.match(r.text, /scaduta ieri/);
  assert.match(r.text, /1\.000,00/);
  assert.match(r.text, /2026-014/);
  assert.match(r.text, /value="339 1234567"/); // cellulare del cliente già proposto per WhatsApp
  assert.match(r.text, /Assistente AI non attivo/);

  r = await vai('/');
  assert.match(r.text, /Presentare integrazioni/);
  assert.match(r.text, /Chiedere visura catastale/);
  assert.match(r.text, /allarme/);

  r = await vai(`${praticaUrl}/genera-messaggio`, { method: 'POST', json: { canale: 'email', istruzioni: 'prova' }, headers: { 'x-csrf-token': csrf } });
  assert.strictEqual(r.status, 503);
  assert.match(JSON.parse(r.text).errore, /ANTHROPIC_API_KEY/);

  r = await vai(`${praticaUrl}/comunicazioni`, { method: 'POST', form: { _csrf: csrf, canale: 'whatsapp', destinatario_nome: 'Mario Rossi', telefono: '339 1234567', testo: 'Buongiorno, la SCIA è stata protocollata.' } });
  assert.strictEqual(r.status, 303);
  assert.match(r.location, /^https:\/\/wa\.me\/393391234567\?text=/);
  r = await vai(`${praticaUrl}/comunicazioni`, { method: 'POST', form: { _csrf: csrf, canale: 'email', email: 'mario@rossi.it', oggetto: 'SCIA', testo: 'Testo' } });
  assert.match(r.location, /^mailto:mario@rossi\.it\?subject=SCIA/);
  r = await vai(praticaUrl);
  assert.match(r.text, /WhatsApp a Mario Rossi/);

  const sid = r.text.match(/scadenze\/(\d+)\/segna/)[1];
  r = await vai(`${praticaUrl}/scadenze/${sid}/segna`, { method: 'POST', form: { _csrf: csrf, fatta: '1', torna: '/#scadenze' } });
  assert.strictEqual(r.location, '/#scadenze');
  r = await vai(`${praticaUrl}/scadenze/${sid}/segna`, { method: 'POST', form: { _csrf: csrf, fatta: '1', torna: '//altro-sito.it' } });
  assert.match(r.location, /^\/pratiche\//); // niente redirect esterni
  r = await vai('/');
  assert.doesNotMatch(r.text, /Presentare integrazioni/);

  r = await vai(clienteUrl);
  assert.match(r.text, /SCIA/);
  r = await vai('/pratiche');
  assert.match(r.text, /Comune di Montevarchi/);

  // Cliente eliminato: la pratica resta
  await vai(`${clienteUrl}/elimina`, { method: 'POST', form: { _csrf: csrf } });
  r = await vai(praticaUrl);
  assert.strictEqual(r.status, 200);
});

test('accetta solo richieste dal PC stesso con indirizzo localhost', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((ok) => server.once('listening', ok));
  t.after(() => server.close());
  const porta = server.address().port;
  const http = require('node:http');
  const prova = (host) => new Promise((ok) => {
    http.get({ host: '127.0.0.1', port: porta, path: '/', headers: { host } }, (res) => { res.resume(); ok(res.statusCode); });
  });
  assert.strictEqual(await prova(`localhost:${porta}`), 200);
  assert.strictEqual(await prova(`127.0.0.1:${porta}`), 200);
  assert.strictEqual(await prova('sito-malevolo.example'), 403); // DNS rebinding
  assert.strictEqual(await prova(`192.168.1.10:${porta}`), 403);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
