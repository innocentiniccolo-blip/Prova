'use strict';
/** Client ClamAV (protocollo INSTREAM) provato contro un finto servizio antivirus. */
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('risposte OK, FOUND e servizio non raggiungibile', async () => {
  let risposta = 'stream: OK';
  const ricevuti = [];
  const finto = net.createServer((s) => {
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.subarray(-4).equals(Buffer.alloc(4))) { ricevuti.push(buf); s.end(`${risposta}\0`); }
    });
  });
  await new Promise((r) => finto.listen(0, '127.0.0.1', r));
  process.env.CLAMAV_HOST = '127.0.0.1';
  process.env.CLAMAV_PORT = String(finto.address().port);
  const av = require('../src/antivirus');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'av-')), 'x.pdf');
  fs.writeFileSync(f, 'contenuto di prova');
  assert.strictEqual((await av.controlla(f)).esito, 'pulito');
  assert.ok(ricevuti[0].toString('latin1').startsWith('zINSTREAM\0'));
  risposta = 'stream: Eicar-Test-Signature FOUND';
  const inf = await av.controlla(f);
  assert.deepStrictEqual([inf.esito, inf.dettaglio], ['infetto', 'Eicar-Test-Signature']);
  await new Promise((r) => finto.close(r));
  assert.strictEqual((await av.controlla(f, { timeoutMs: 2000 })).esito, 'non-controllato');
});
