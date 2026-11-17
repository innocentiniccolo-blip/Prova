'use strict';
/**
 * Lettura dei PDF "fotografati" (stampe del browser, scansioni): quando il PDF non contiene testo,
 * le pagine vengono trasformate in immagini (pdftoppm) e lette con Tesseract in italiano.
 * Serve per i documenti delle imprese (es. la patente a crediti stampata dal portale INL).
 * Se gli strumenti non ci sono (es. in sviluppo su Windows) restituisce il testo normale, anche vuoto.
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { testoPdf } = require('./ricevute');

const esegui = (cmd, args, opz = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 60000, maxBuffer: 10 * 1024 * 1024, ...opz }, (err, out) => (err ? reject(err) : resolve(out)));
});

let disponibile = null;
async function ocrDisponibile() {
  if (disponibile === null) {
    try { await esegui('tesseract', ['--version']); await esegui('pdftoppm', ['-v']); disponibile = true; } catch { disponibile = false; }
  }
  return disponibile;
}

/** Testo delle prime pagine di un PDF immagine, letto con OCR. */
async function ocrPdf(abs, { pagine = 4 } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocr-'));
  try {
    // -scale-to: dimensione massima fissa, così una pagina gigante non esaurisce la memoria
    await esegui('pdftoppm', ['-scale-to', '2400', '-gray', '-png', '-f', '1', '-l', String(pagine), abs, path.join(dir, 'p')]);
    let testo = '';
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.png')).sort()) {
      testo += await esegui('tesseract', [path.join(dir, f), '-', '-l', 'ita', '--psm', '4']) + '\n';
    }
    return testo;
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

/** Testo del PDF; se non ne ha (PDF immagine) prova con l'OCR. */
async function testoDocumento(abs, opz = {}) {
  let testo = '';
  try { testo = await testoPdf(abs, opz); } catch { /* PDF non leggibile come testo */ }
  if (testo.replace(/\s+/g, '').length >= 40) return testo;
  if (!(await ocrDisponibile())) return testo;
  try { return await ocrPdf(abs, opz); } catch (e) { console.warn('OCR non riuscito:', e.message); return testo; }
}

module.exports = { testoDocumento, ocrDisponibile };
