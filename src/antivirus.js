'use strict';
/**
 * Controllo antivirus dei file che arrivano da fuori (imprese: link di caricamento ed email).
 * Usa ClamAV (servizio "clamd" in rete, protocollo INSTREAM). Si attiva con CLAMAV_HOST nel .env.
 *
 * Esito: { esito: 'pulito' | 'infetto' | 'non-controllato', dettaglio }
 *  - pulito: ClamAV non ha trovato niente
 *  - infetto: ClamAV ha trovato una minaccia (il file va scartato)
 *  - non-controllato: antivirus non configurato o non raggiungibile (il file resta da controllare con un avviso)
 */
const net = require('node:net');
const fs = require('node:fs');

const host = process.env.CLAMAV_HOST || '';
const port = Number(process.env.CLAMAV_PORT) || 3310;
const attivo = Boolean(host);

function controlla(percorso, { timeoutMs = 60000 } = {}) {
  if (!attivo) return Promise.resolve({ esito: 'non-controllato', dettaglio: 'antivirus non attivo' });
  return new Promise((resolve) => {
    let finito = false;
    let risposta = '';
    const fine = (r) => { if (finito) return; finito = true; sock.destroy(); resolve(r); };
    const sock = net.createConnection({ host, port });
    sock.setTimeout(timeoutMs, () => fine({ esito: 'non-controllato', dettaglio: 'antivirus non risponde' }));
    sock.on('error', (e) => fine({ esito: 'non-controllato', dettaglio: `antivirus non raggiungibile (${e.code || e.message})` }));
    sock.on('data', (d) => { risposta += d.toString('latin1'); });
    sock.on('end', () => {
      const r = risposta.replace(/\0/g, '').trim();
      if (/\bOK$/.test(r)) fine({ esito: 'pulito', dettaglio: 'ClamAV: nessuna minaccia' });
      else if (/FOUND$/.test(r)) fine({ esito: 'infetto', dettaglio: r.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '') });
      else fine({ esito: 'non-controllato', dettaglio: `risposta antivirus non chiara: ${r.slice(0, 80)}` });
    });
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      const flusso = fs.createReadStream(percorso, { highWaterMark: 64 * 1024 });
      flusso.on('data', (chunk) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(chunk.length);
        if (!sock.write(Buffer.concat([len, chunk]))) { flusso.pause(); sock.once('drain', () => flusso.resume()); }
      });
      flusso.on('end', () => sock.write(Buffer.alloc(4)));
      flusso.on('error', () => fine({ esito: 'non-controllato', dettaglio: 'file non leggibile' }));
    });
  });
}

module.exports = { attivo, controlla };
