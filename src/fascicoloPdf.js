'use strict';
/**
 * Fascicolo del fabbricato in PDF, su carta intestata dello studio.
 * Riceve i dati già pronti da fabbricato.fascicolo() e restituisce un Buffer.
 */
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const config = require('./config');

const BLU = '#004587';
const AZZURRO = '#287dbe';
const GRIGIO = '#5b6470';
const LINEA = '#c9d3df';
const TONI = { ok: '#2e7d32', ko: '#c62828', attesa: '#ef8f00', neutro: '#8a94a0' };
const COLORI_APE = { A4: '#00843d', A3: '#1a9641', A2: '#3cab4a', A1: '#66bd4f', B: '#a6d96a', C: '#d9ef8b', D: '#fee08b', E: '#fdae61', F: '#f46d43', G: '#d73027' };
const M = 50; // margini

function intestazione(doc) {
  const s = config.studio;
  const top = 32;
  // Logo dello studio (stesse forme di public/img/logo.svg, viewBox 418×387)
  const k = 44 / 387;
  doc.save().translate(M, top).scale(k);
  doc.polygon([25, 14], [135, 14], [267, 197], [267, 380], [135, 198], [135, 380], [25, 380]).fill(BLU);
  doc.circle(337, 61, 56).fill(AZZURRO);
  doc.rect(282, 128, 111, 252).fill('#125a9a');
  doc.restore();
  const x = M + 60;
  doc.fillColor(BLU).font('Helvetica-Bold').fontSize(12).text(s.nome, x, top + 2, { lineBreak: false });
  doc.fillColor(GRIGIO).font('Helvetica').fontSize(8);
  doc.text(s.indirizzo, x, top + 18, { lineBreak: false });
  doc.text([s.telefono && `Cell. ${s.telefono}`, s.email, s.pec && `PEC ${s.pec}`].filter(Boolean).join('  ·  '), x, top + 28, { lineBreak: false });
  doc.text([s.albo, s.piva && `P.IVA ${s.piva}`].filter(Boolean).join('  ·  '), x, top + 38, { lineBreak: false, width: doc.page.width - x - M, ellipsis: true });
  doc.moveTo(M, top + 54).lineTo(doc.page.width - M, top + 54).lineWidth(1.2).strokeColor(BLU).stroke();
  doc.x = M; doc.y = top + 70;
}

function piede(doc, i, n, data) {
  const y = doc.page.height - 42;
  doc.moveTo(M, y - 6).lineTo(doc.page.width - M, y - 6).lineWidth(0.5).strokeColor(LINEA).stroke();
  doc.fillColor(GRIGIO).font('Helvetica').fontSize(7)
    .text(`Documento informativo redatto il ${data} sulla base dei documenti presenti nell'archivio dello studio. Non sostituisce la relazione tecnica, i titoli edilizi, l'APE e le visure ufficiali.`, M, y, { width: doc.page.width - 2 * M - 60, lineGap: 1 })
    .text(`Pagina ${i} di ${n}`, doc.page.width - M - 60, y, { width: 60, align: 'right', lineBreak: false });
}

function spazio(doc, h) {
  if (doc.y + h > doc.page.height - 70) { doc.addPage(); }
}

function sezione(doc, titolo) {
  spazio(doc, 60);
  doc.moveDown(0.6);
  doc.fillColor(BLU).font('Helvetica-Bold').fontSize(10).text(titolo.toUpperCase(), M, doc.y, { characterSpacing: 0.4 });
  doc.moveTo(M, doc.y + 2).lineTo(doc.page.width - M, doc.y + 2).lineWidth(0.5).strokeColor(LINEA).stroke();
  doc.y += 8;
}

/** Riga «etichetta: valore»; restituisce l'altezza usata. */
function voce(doc, etichetta, valore, { larghezza, x = M, tono } = {}) {
  const w = larghezza || doc.page.width - 2 * M;
  const le = 130;
  const testo = valore || '—';
  doc.font('Helvetica').fontSize(10);
  const h = Math.max(14, doc.heightOfString(testo, { width: w - le - (tono ? 14 : 0) }) + 4);
  spazio(doc, h);
  const y = doc.y;
  doc.fillColor(GRIGIO).font('Helvetica').fontSize(9).text(etichetta, x, y + 1, { width: le - 8 });
  let xv = x + le;
  if (tono) { doc.circle(xv + 4, y + 6, 3.6).fill(TONI[tono] || TONI.neutro); xv += 14; }
  doc.fillColor('#1d2733').font('Helvetica').fontSize(10).text(testo, xv, y, { width: w - (xv - x), align: 'left' });
  doc.x = M; doc.y = y + h;
  return h;
}

function tabellaCatasto(doc, unita) {
  const col = [['Foglio', 45], ['Particella', 60], ['Sub.', 38], ['Categoria', 62], ['Classe', 42], ['Consistenza', 82], ['Rendita', 0]];
  const w = doc.page.width - 2 * M;
  col[col.length - 1][1] = w - col.slice(0, -1).reduce((a, c) => a + c[1], 0);
  const riga = (valori, testa) => {
    spazio(doc, 18);
    const y = doc.y;
    if (testa) doc.rect(M, y - 2, w, 16).fill('#eef3f8');
    let x = M + 4;
    valori.forEach((v, i) => {
      doc.fillColor(testa ? BLU : '#1d2733').font(testa ? 'Helvetica-Bold' : 'Helvetica').fontSize(testa ? 8.5 : 9.5).text(v || '—', x, y + 2, { width: col[i][1] - 6, lineBreak: false, ellipsis: true });
      x += col[i][1];
    });
    doc.y = y + 16;
    doc.moveTo(M, doc.y - 1).lineTo(M + w, doc.y - 1).lineWidth(0.3).strokeColor(LINEA).stroke();
  };
  riga(col.map((c) => c[0]), true);
  for (const u of unita) riga([u.foglio, u.particella, u.sub, u.categoria, u.classe, u.consistenza, u.rendita]);
  doc.x = M;
}

function scalaApe(doc, classe) {
  const classi = Object.keys(COLORI_APE);
  const w = (doc.page.width - 2 * M - 130) / classi.length;
  spazio(doc, 30);
  const y = doc.y + 2;
  classi.forEach((c, i) => {
    const x = M + 130 + i * w;
    const attiva = c === classe;
    doc.rect(x + 1, attiva ? y - 3 : y, w - 2, attiva ? 22 : 16).fill(COLORI_APE[c]);
    if (attiva) doc.rect(x + 1, y - 3, w - 2, 22).lineWidth(1.5).strokeColor('#1d2733').stroke();
    doc.fillColor(['G', 'F', 'A4', 'A3', 'A2'].includes(c) ? '#ffffff' : '#1d2733').font(attiva ? 'Helvetica-Bold' : 'Helvetica').fontSize(attiva ? 11 : 8)
      .text(c, x + 1, attiva ? y + 2 : y + 4, { width: w - 2, align: 'center', lineBreak: false });
  });
  doc.fillColor(GRIGIO).font('Helvetica').fontSize(9).text('Classe energetica', M, y + 3, { lineBreak: false });
  doc.x = M; doc.y = y + 26;
}

/** @param f dati di fabbricato.fascicolo(); @param formattaData iso → gg/mm/aaaa */
async function creaPdf(f, formattaData) {
  const oggi = formattaData(new Date().toISOString().slice(0, 10));
  const doc = new PDFDocument({ size: 'A4', margins: { top: 100, bottom: 60, left: M, right: M }, bufferPages: true,
    info: { Title: `Fascicolo del fabbricato – ${f.indirizzo || f.titolo}`, Author: config.studio.nome, Subject: 'Fascicolo del fabbricato' } });
  const parti = [];
  doc.on('data', (b) => parti.push(b));
  const fine = new Promise((ok) => doc.on('end', ok));
  doc.on('pageAdded', () => intestazione(doc));
  intestazione(doc);

  // Titolo
  doc.fillColor('#1d2733').font('Helvetica-Bold').fontSize(14).text('FASCICOLO DEL FABBRICATO', M, doc.y, { align: 'center', width: doc.page.width - 2 * M });
  doc.moveDown(0.2);
  const semplice = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const conComune = f.comune && !semplice(f.indirizzo).includes(semplice(f.comune));
  const sotto = [f.indirizzo, conComune && `Comune di ${f.comune}`].filter(Boolean).join(' – ') || f.titolo;
  doc.font('Helvetica').fontSize(10).fillColor(GRIGIO).text(sotto, { align: 'center', width: doc.page.width - 2 * M });
  doc.moveDown(0.3);

  // Ubicazione con QR code della posizione
  sezione(doc, 'Ubicazione');
  const yU = doc.y;
  const wTesto = f.mappa ? doc.page.width - 2 * M - 100 : undefined;
  voce(doc, 'Indirizzo', f.indirizzo, { larghezza: wTesto });
  voce(doc, 'Comune', f.comune, { larghezza: wTesto });
  if (f.coordinate) voce(doc, 'Coordinate', f.coordinate.replace(',', ', '), { larghezza: wTesto });
  if (f.mappa) {
    const yl = doc.y;
    doc.fillColor(GRIGIO).font('Helvetica').fontSize(9).text('Posizione', M, yl + 1);
    doc.fillColor(AZZURRO).font('Helvetica').fontSize(10).text('Apri in Google Maps', M + 130, yl, { link: f.mappa, underline: true });
    doc.y = Math.max(doc.y, yl + 14);
    const qr = await QRCode.toBuffer(f.mappa, { margin: 1, width: 240, errorCorrectionLevel: 'M', color: { dark: '#1d2733', light: '#ffffff' } });
    doc.image(qr, doc.page.width - M - 84, yU - 2, { width: 84, link: f.mappa });
    doc.fillColor(GRIGIO).fontSize(7).text('Inquadra per la mappa', doc.page.width - M - 90, yU + 84, { width: 96, align: 'center' });
    doc.y = Math.max(doc.y, yU + 96);
  }
  doc.x = M;

  // Dati catastali
  sezione(doc, 'Dati catastali');
  if (f.catastoTesto) voce(doc, 'Identificativi', f.catastoTesto);
  else if (f.catasto.length) tabellaCatasto(doc, f.catasto);
  else voce(doc, 'Identificativi', 'In fase di reperimento');
  doc.y += 4;
  if (f.catastale) voce(doc, 'Conformità catastale', f.catastale.testo, { tono: f.catastale.tono });

  // Situazione urbanistica
  sezione(doc, 'Situazione urbanistica');
  voce(doc, 'Conformità urbanistica', f.urbanistica.testo, { tono: f.urbanistica.tono });
  if (f.urbanistica.nota) voce(doc, '', f.urbanistica.nota);
  if (f.urbanistica.titoli.length) voce(doc, 'Titoli edilizi', f.urbanistica.titoli.join('\n'));
  if (f.urbanistica.fonte) voce(doc, 'Fonte', `Relazione tecnica di conformità («${f.urbanistica.fonte}»)`);
  for (const p of f.pratiche) voce(doc, p.voce, p.testo, { tono: p.tono });

  // Prestazione energetica
  sezione(doc, 'Prestazione energetica');
  if (f.ape.classe) scalaApe(doc, f.ape.classe);
  else voce(doc, 'Classe energetica', 'APE non ancora disponibile', { tono: 'neutro' });
  if (f.ape.ep) voce(doc, 'EP gl,nren', `${f.ape.ep} kWh/mq anno`);
  if (f.ape.scadenza) voce(doc, 'Validità', `fino al ${formattaData(f.ape.scadenza)}`, { tono: f.ape.scadenza < new Date().toISOString().slice(0, 10) ? 'ko' : 'ok' });
  else if (f.ape.testoScheda) voce(doc, 'Validità', f.ape.testoScheda);
  if (f.ape.codice) voce(doc, 'Codice APE', f.ape.codice);

  // Descrizione
  sezione(doc, "Descrizione sintetica dell'unità");
  spazio(doc, 40);
  doc.fillColor('#1d2733').font('Helvetica').fontSize(10).text(f.descrizione || 'In fase di redazione.', M, doc.y, { width: doc.page.width - 2 * M, align: 'justify', lineGap: 1.5 });

  if (f.nota) {
    sezione(doc, 'Note dello studio');
    doc.fillColor('#1d2733').font('Helvetica').fontSize(10).text(f.nota, M, doc.y, { width: doc.page.width - 2 * M, align: 'justify' });
  }

  // Firma
  spazio(doc, 70);
  doc.moveDown(2);
  doc.fillColor('#1d2733').font('Helvetica').fontSize(10).text(`${config.studio.nomeBreve || config.studio.nome}`, M, doc.y, { width: doc.page.width - 2 * M, align: 'right' });

  const pagine = doc.bufferedPageRange();
  for (let i = 0; i < pagine.count; i++) {
    doc.switchToPage(pagine.start + i);
    const fondo = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // il piè di pagina sta nel margine: senza questo pdfkit aprirebbe una pagina nuova
    piede(doc, i + 1, pagine.count, oggi);
    doc.page.margins.bottom = fondo;
  }
  doc.end();
  await fine;
  return Buffer.concat(parti);
}

module.exports = { creaPdf, intestazione, COLORI: { BLU, AZZURRO, GRIGIO, LINEA }, M };
