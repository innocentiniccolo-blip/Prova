'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cruscotto-gemini-'));
process.env.DATI_DIR = tmp;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_MODELLO;
process.env.GEMINI_API_KEY = 'chiave-finta';

// Server finto che risponde come l'API di Gemini
const richieste = [];
let comportamento = 'ok';
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    richieste.push({ url: req.url, body: JSON.parse(b || '{}'), chiave: req.headers['x-goog-api-key'] });
    res.setHeader('content-type', 'application/json');
    const errore = (status, message) => { res.statusCode = status; res.end(JSON.stringify({ error: { code: status, message, status: 'ERR' } })); };
    if (comportamento === 'chiave') return errore(400, 'API key not valid. Please pass a valid API key.');
    if (comportamento === 'quota') return errore(429, 'Resource has been exhausted');
    if (comportamento === 'modello' && req.url.includes('gemini-3.8-flash')) return errore(404, 'models/gemini-3.8-flash is not found');
    res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({ oggetto: 'SCIA – aggiornamento', testo: 'Gentile Sig. Rossi, ...' }) }] }, finishReason: 'STOP' }] }));
  });
});

test.before(async () => {
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const ai = require('../src/ai');
const pratica = { commessa: '2026-014', tipo: 'SCIA', stato: 'Presentata', protocollo: '28451', onorario_cent: 0, incassato_cent: 0 };

test('con la sola chiave Gemini usa Gemini e chiede una risposta JSON con lo schema', async () => {
  assert.strictEqual(ai.fornitore(), 'gemini');
  const r = await ai.generaMessaggio({ pratica, canale: 'email', destinatario: 'Mario Rossi', istruzioni: 'aggiorna' });
  assert.deepStrictEqual(r, { oggetto: 'SCIA – aggiornamento', testo: 'Gentile Sig. Rossi, ...' });
  const q = richieste.at(-1);
  assert.match(q.url, /models\/gemini-3\.8-flash:generateContent/);
  assert.strictEqual(q.chiave, 'chiave-finta');
  assert.strictEqual(q.body.generationConfig.responseMimeType, 'application/json');
  assert.deepStrictEqual(q.body.generationConfig.responseJsonSchema.required, ['oggetto', 'testo']);
  assert.match(JSON.stringify(q.body.systemInstruction), /Studio Tecnico/);
  assert.match(JSON.stringify(q.body.contents), /Protocollo: n\. 28451/);
});

test('modello non disponibile: ripiega su gemini-flash-latest', async () => {
  comportamento = 'modello';
  richieste.length = 0;
  const r = await ai.generaMessaggio({ pratica, canale: 'whatsapp', istruzioni: 'x' });
  assert.strictEqual(r.oggetto, ''); // WhatsApp: niente oggetto
  assert.match(richieste[0].url, /gemini-3\.8-flash/);
  assert.match(richieste.at(-1).url, /gemini-flash-latest/);
});

test('errori spiegati in italiano', async () => {
  comportamento = 'chiave';
  await assert.rejects(ai.generaMessaggio({ pratica, canale: 'email' }), (e) => e instanceof ai.ErroreAI && /GEMINI_API_KEY non valida/.test(e.message));
  comportamento = 'quota';
  await assert.rejects(ai.generaMessaggio({ pratica, canale: 'email' }), (e) => e instanceof ai.ErroreAI && /Limite gratuito/.test(e.message));
});

test('se ci sono entrambe le chiavi decide AI_FORNITORE', () => {
  process.env.ANTHROPIC_API_KEY = 'x';
  assert.strictEqual(ai.fornitore(), 'claude');
  process.env.AI_FORNITORE = 'gemini';
  assert.strictEqual(ai.fornitore(), 'gemini');
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AI_FORNITORE;
});
