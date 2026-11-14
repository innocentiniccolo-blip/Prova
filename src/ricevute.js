'use strict';
/** Riconoscimento delle ricevute (le regole vengono completate con i formati reali). */
const fs = require('node:fs');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

async function testoPdf(abs) {
  const dati = await pdfParse(fs.readFileSync(abs), { max: 3 });
  return dati.text || '';
}

function riconosci() { return null; }

async function analizza(abs, nomeFile) {
  const testo = await testoPdf(abs);
  return riconosci(testo, nomeFile);
}

module.exports = { testoPdf, riconosci, analizza };
