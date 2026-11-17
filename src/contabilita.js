'use strict';
/**
 * Contabilità: bozze di notula/proforma (solo pannello dello studio).
 * Gli importi sono sempre in centesimi interi. Non sono fatture: la fattura elettronica si emette altrove.
 */
const PDFDocument = require('pdfkit');
const config = require('./config');
const { db } = require('./modelli');
const { intestazione, COLORI, M } = require('./fascicoloPdf');

const { BLU, GRIGIO, LINEA } = COLORI;
const SOGLIA_BOLLO = 7747; // 77,47 €
const BOLLO = 200;
const RITENUTA_PCT = 20;
const STATI = ['bozza', 'inviata', 'pagata'];

const Q = {
  tutte: db.prepare(`SELECT n.*, l.codice AS lavoro_codice, l.titolo AS lavoro_titolo FROM notule n
    LEFT JOIN lavori l ON l.id = n.lavoro_id ORDER BY n.anno DESC, n.numero DESC`),
  perId: db.prepare('SELECT * FROM notule WHERE id = ?'),
  prossimo: db.prepare('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM notule WHERE anno = ?'),
  inserisci: db.prepare(`INSERT INTO notule (anno, numero, lavoro_id, dest_nome, dest_indirizzo, dest_cf, dest_email, oggetto, data, voci, spese, cassa_pct, iva_pct, sostituto, note)
    VALUES (:anno, :numero, :lavoro_id, :dest_nome, :dest_indirizzo, :dest_cf, :dest_email, :oggetto, :data, :voci, :spese, :cassa_pct, :iva_pct, :sostituto, :note)`),
  aggiorna: db.prepare(`UPDATE notule SET lavoro_id = :lavoro_id, dest_nome = :dest_nome, dest_indirizzo = :dest_indirizzo, dest_cf = :dest_cf,
    dest_email = :dest_email, oggetto = :oggetto, data = :data, voci = :voci, spese = :spese, cassa_pct = :cassa_pct, iva_pct = :iva_pct,
    sostituto = :sostituto, note = :note WHERE id = :id`),
  segnaInviata: db.prepare("UPDATE notule SET stato = 'inviata', inviata_il = datetime('now') WHERE id = ? AND stato = 'bozza'"),
  stato: db.prepare('UPDATE notule SET stato = :stato, pagata_il = :pagata WHERE id = :id'),
  elimina: db.prepare("DELETE FROM notule WHERE id = ? AND stato IN ('bozza', 'inviata')"),
};

/** «1.234,56», «1234,56» o «1234.56» → centesimi (null se non valido). */
function importo(v) {
  let t = String(v ?? '').replace(/[€\s]/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(parseFloat(t) * 100);
}

/** Righe del modulo (descrizioni e importi in parallelo) → [{d, c}], scartando le righe vuote. */
function righe(descrizioni, importi) {
  const d = [].concat(descrizioni ?? []);
  const i = [].concat(importi ?? []);
  const out = [];
  for (let k = 0; k < d.length; k++) {
    const desc = String(d[k] || '').trim().slice(0, 300);
    const c = importo(i[k]);
    if (!desc && c === null) continue;
    out.push({ d: desc, c: c ?? 0 });
  }
  return out;
}

const percentuale = (v, def) => {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : def;
};

const tonda = (x) => Math.round(x + 1e-9);

/** Totali di una notula (tutto in centesimi). */
function calcola({ voci, spese, cassa_pct = 5, iva_pct = 22, sostituto = 0 }) {
  const compenso = voci.reduce((s, v) => s + v.c, 0);
  const cassa = tonda(compenso * cassa_pct / 100);
  const imponibile = compenso + cassa;
  const iva = tonda(imponibile * iva_pct / 100);
  const anticipate = spese.reduce((s, v) => s + v.c, 0);
  const bollo = anticipate > SOGLIA_BOLLO ? BOLLO : 0;
  const totale = imponibile + iva + anticipate + bollo;
  const ritenuta = sostituto ? tonda(compenso * RITENUTA_PCT / 100) : 0;
  return { compenso, cassa, imponibile, iva, anticipate, bollo, totale, ritenuta, netto: totale - ritenuta };
}

const leggi = (n) => ({ ...n, voci: JSON.parse(n.voci || '[]'), spese: JSON.parse(n.spese || '[]') });
const codice = (n) => `${n.anno}/P-${String(n.numero).padStart(3, '0')}`;
const eur = (c) => (c / 100).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

function crea(dati) {
  const anno = Number(String(dati.data).slice(0, 4)) || new Date().getFullYear();
  for (let tentativo = 0; tentativo < 3; tentativo++) {
    try {
      const numero = Q.prossimo.get(anno).n;
      return Number(Q.inserisci.run({ ...dati, anno, numero }).lastInsertRowid);
    } catch (e) { if (!/UNIQUE/.test(e.message)) throw e; }
  }
  throw new Error('Numero notula non assegnato');
}

/** PDF su carta intestata. @returns Promise<Buffer> */
async function creaPdf(n, formattaData) {
  const t = calcola(n);
  const doc = new PDFDocument({ size: 'A4', margins: { top: 100, bottom: 60, left: M, right: M }, bufferPages: true,
    info: { Title: `Notula ${codice(n)}`, Author: config.studio.nome, Subject: 'Notula / proforma' } });
  const parti = [];
  doc.on('data', (b) => parti.push(b));
  const fine = new Promise((ok) => doc.on('end', ok));
  doc.on('pageAdded', () => intestazione(doc));
  intestazione(doc);
  const W = doc.page.width - 2 * M;
  const spazio = (h) => { if (doc.y + h > doc.page.height - 80) doc.addPage(); };

  doc.fillColor('#1d2733').font('Helvetica-Bold').fontSize(13).text(`NOTULA / PROFORMA n. ${codice(n)}`, M, doc.y, { width: W * 0.6, lineBreak: false });
  doc.font('Helvetica').fontSize(10).text(`Data: ${formattaData(n.data)}`, M, doc.y, { width: W, align: 'right' });
  doc.moveDown(0.3);
  doc.fillColor('#b3261e').fontSize(8.5).text("Documento non valido ai fini fiscali. La fattura elettronica sarà emessa al momento dell'incasso.", M, doc.y, { width: W });
  doc.moveDown(1);

  const y0 = doc.y;
  doc.fillColor(GRIGIO).font('Helvetica-Bold').fontSize(8.5).text('SPETT.LE', M, y0).text('OGGETTO', M + 270, y0);
  doc.fillColor('#1d2733').font('Helvetica').fontSize(10);
  const dest = [n.dest_nome, n.dest_indirizzo, n.dest_cf && `C.F./P.IVA ${n.dest_cf}`].filter(Boolean).join('\n');
  doc.text(dest || '—', M, y0 + 13, { width: 250 });
  const yA = doc.y;
  doc.text(n.oggetto || '—', M + 270, y0 + 13, { width: W - 270 });
  doc.x = M; doc.y = Math.max(yA, doc.y) + 18;

  // Tabella prestazioni
  const colI = 90;
  const riga = (testo, c, { testa = false, zebra = false } = {}) => {
    doc.font('Helvetica').fontSize(9.5);
    const h = Math.max(20, doc.heightOfString(testo, { width: W - colI - 16 }) + 10);
    spazio(h);
    const y = doc.y;
    if (testa) doc.rect(M, y, W, 20).fill(BLU);
    else if (zebra) doc.rect(M, y, W, h).fill('#f1f4f8');
    doc.fillColor(testa ? '#fff' : '#1d2733').font(testa ? 'Helvetica-Bold' : 'Helvetica').fontSize(testa ? 9 : 9.5)
      .text(testo, M + 8, y + (testa ? 6 : 5), { width: W - colI - 16 })
      .text(c, M + W - colI - 8, y + (testa ? 6 : 5), { width: colI, align: 'right' });
    doc.x = M; doc.y = y + (testa ? 20 : h);
  };
  riga('Prestazione', 'Importo', { testa: true });
  n.voci.forEach((v, i) => riga(v.d || '—', eur(v.c), { zebra: i % 2 === 0 }));
  doc.moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(0.5).strokeColor(LINEA).stroke();
  doc.y += 10;

  // Totali
  const tot = (etichetta, c, forte = false) => {
    spazio(18);
    const y = doc.y;
    doc.fillColor('#1d2733').font(forte ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5)
      .text(etichetta, M + 150, y, { width: W - 150 - colI - 8 })
      .text(c, M + W - colI - 8, y, { width: colI, align: 'right' });
    doc.x = M; doc.y = Math.max(doc.y, y + 14) + 3;
  };
  tot('Compenso professionale', eur(t.compenso));
  tot(`Contributo integrativo Cassa Geometri (${String(n.cassa_pct).replace('.', ',')}%)`, eur(t.cassa));
  tot('Imponibile IVA', eur(t.imponibile), true);
  tot(`IVA ${String(n.iva_pct).replace('.', ',')}%`, eur(t.iva));
  n.spese.forEach((s) => tot(`Spese anticipate in nome e per conto del cliente (art. 15 DPR 633/72): ${s.d || '—'}`, eur(s.c)));
  if (t.bollo) tot('Imposta di bollo', eur(t.bollo));
  doc.y += 4;
  spazio(34);
  const yT = doc.y;
  doc.rect(M + 150, yT, W - 150, 26).fill(BLU);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(11)
    .text('TOTALE DA CORRISPONDERE', M + 160, yT + 8, { lineBreak: false })
    .text(eur(t.totale), M + W - 110, yT + 8, { width: 102, align: 'right', lineBreak: false });
  doc.x = M; doc.y = yT + 34;
  if (t.ritenuta) {
    tot(`Ritenuta d'acconto ${RITENUTA_PCT}% sul compenso (versata dal cliente)`, '− ' + eur(t.ritenuta));
    tot('NETTO A PAGARE', eur(t.netto), true);
  }

  doc.moveDown(1);
  spazio(80);
  if (n.note) {
    doc.fillColor(GRIGIO).font('Helvetica-Bold').fontSize(8.5).text('NOTE', M, doc.y);
    doc.fillColor('#1d2733').font('Helvetica').fontSize(9.5).text(n.note, M, doc.y + 2, { width: W });
    doc.moveDown(0.8);
  }
  if (config.studio.iban) {
    doc.fillColor(GRIGIO).font('Helvetica-Bold').fontSize(8.5).text('PAGAMENTO', M, doc.y);
    doc.fillColor('#1d2733').font('Helvetica').fontSize(9.5)
      .text(`Bonifico a ${config.studio.nome}\nIBAN ${config.studio.iban}\nCausale: Notula ${codice(n)}`, M, doc.y + 2, { width: W });
  }

  const pagine = doc.bufferedPageRange();
  for (let i = 0; i < pagine.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - 42;
    doc.fillColor(GRIGIO).font('Helvetica').fontSize(7)
      .text(`Notula/proforma ${codice(n)} - documento non fiscale`, M, y, { width: W - 60, lineBreak: false })
      .text(`Pagina ${i + 1} di ${pagine.count}`, doc.page.width - M - 60, y, { width: 60, align: 'right', lineBreak: false });
  }
  doc.end();
  await fine;
  return Buffer.concat(parti);
}

module.exports = { Q, STATI, importo, righe, percentuale, calcola, leggi, codice, eur, crea, creaPdf, RITENUTA_PCT };
