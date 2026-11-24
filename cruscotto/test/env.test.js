'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { caricaEnv, mascherata } = require('../src/env');

function prova(file, contenuto, nomeVar = 'PROVA_CHIAVE') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cruscotto-env-'));
  for (const [nome, buf] of Object.entries(typeof file === 'string' ? { [file]: contenuto } : file)) fs.writeFileSync(path.join(dir, nome), buf);
  delete process.env[nomeVar];
  const r = caricaEnv(dir);
  const v = process.env[nomeVar];
  delete process.env[nomeVar];
  fs.rmSync(dir, { recursive: true, force: true });
  return { v, r };
}

test('casi normali', () => {
  assert.strictEqual(prova('.env', 'PROVA_CHIAVE=AIza123\n').v, 'AIza123');
  assert.strictEqual(prova('.env', '# commento\nPROVA_CHIAVE = "AIza123"  \r\n').v, 'AIza123');
  assert.strictEqual(prova('.env', 'EMAIL_PASSWORD=ab#c=d\n', 'EMAIL_PASSWORD').v, 'ab#c=d'); // # e = nelle password
});

test('riga ripetuta: il valore scritto vince su quello vuoto', () => {
  assert.strictEqual(prova('.env', 'PROVA_CHIAVE=AIza123\nALTRO=1\nPROVA_CHIAVE=\n').v, 'AIza123');
  assert.strictEqual(prova('.env', 'PROVA_CHIAVE=\nPROVA_CHIAVE=AIza123\n').v, 'AIza123');
});

test('codifiche del Blocco note: UTF-8 con BOM e Unicode (UTF-16)', () => {
  assert.strictEqual(prova('.env', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('PROVA_CHIAVE=AIza123\r\n')])).v, 'AIza123');
  assert.strictEqual(prova('.env', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('PROVA_CHIAVE=AIza123\r\n', 'utf16le')])).v, 'AIza123');
  const be = Buffer.from('PROVA_CHIAVE=AIza123\r\n', 'utf16le'); be.swap16();
  assert.strictEqual(prova('.env', Buffer.concat([Buffer.from([0xfe, 0xff]), be])).v, 'AIza123');
});

test('file salvato come .env.txt, anche accanto a un .env vuoto', () => {
  assert.strictEqual(prova('.env.txt', 'PROVA_CHIAVE=AIza123\n').v, 'AIza123');
  const { v, r } = prova({ '.env': 'PROVA_CHIAVE=\n', '.env.txt': 'PROVA_CHIAVE=AIza123\n' });
  assert.strictEqual(v, 'AIza123');
  assert.strictEqual(r.files.length, 2);
});

test('file mancante e chiave mascherata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cruscotto-env-'));
  assert.strictEqual(caricaEnv(dir).file, null);
  fs.rmSync(dir, { recursive: true });
  assert.strictEqual(mascherata('AIzaSyB3xxxxxxxxxxxxxxxxxxxxxxxxxxxQKxA'), 'AIzaSy…QKxA (39 caratteri)');
});
