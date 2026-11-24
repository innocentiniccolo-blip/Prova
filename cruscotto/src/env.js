'use strict';
/**
 * Lettura del file .env, tollerante con i "tranelli" di Windows e del Blocco note:
 *  - file salvato come ".env.txt" (estensioni nascoste in Esplora risorse);
 *  - codifica UTF-8 con BOM o "Unicode" (UTF-16);
 *  - riga ripetuta: un valore scritto vince sempre su una riga vuota (es. GEMINI_API_KEY= del modello);
 *  - spazi attorno all'uguale e virgolette attorno al valore.
 * Le variabili già impostate nel sistema hanno la precedenza sul file.
 */
const fs = require('node:fs');
const path = require('node:path');

const NOMI = ['.env', '.env.txt', 'env.txt', '.env.env'];

function decodifica(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const b = Buffer.from(buf.subarray(2));
    b.swap16();
    return b.toString('utf16le');
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

function analizza(testo) {
  const valori = {};
  for (const riga of testo.split(/\r\n|\n|\r/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(riga);
    if (!m || riga.trim().startsWith('#')) continue;
    let v = m[2];
    if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) v = v.slice(1, -1);
    if (v !== '' || !(m[1] in valori)) valori[m[1]] = v; // un valore vince su una riga vuota
  }
  return valori;
}

/**
 * Carica in process.env i file .env della cartella (anche .env.txt ecc.: li unisce, e un valore scritto
 * vince sempre su uno vuoto).
 * @returns {{ file: string|null, files: string[], valori: Record<string,string> }}
 */
function caricaEnv(cartella) {
  const files = [];
  const valori = {};
  for (const nome of NOMI) {
    const p = path.join(cartella, nome);
    let buf;
    try { buf = fs.readFileSync(p); } catch { continue; }
    files.push(p);
    for (const [k, v] of Object.entries(analizza(decodifica(buf)))) {
      if (v !== '' || !(k in valori)) valori[k] = v;
    }
  }
  for (const [k, v] of Object.entries(valori)) {
    if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
  }
  return { file: files[0] || null, files, valori };
}

/** "AIzaSy…QKxA (39 caratteri)": per controllare la chiave senza mostrarla tutta. */
function mascherata(chiave) {
  const c = String(chiave || '');
  if (!c) return '';
  return c.length <= 10 ? `${c.slice(0, 2)}… (${c.length} caratteri)` : `${c.slice(0, 6)}…${c.slice(-4)} (${c.length} caratteri)`;
}

module.exports = { caricaEnv, analizza, decodifica, mascherata, NOMI };
