'use strict';
/**
 * Accesso all'archivio lavori sul NAS.
 *
 * Ogni lavoro ha una cartella (relativa ad ARCHIVIO_DIR). Ogni sottocartella
 * diretta del lavoro è una PRATICA (es. "Accesso atti", "CILA", "Fine lavori").
 * Il cliente vede solo le pratiche che lo studio ha reso visibili (vedi src/pratiche.js).
 * File e cartelle che iniziano con "." o "_" sono sempre nascosti (utile per le bozze).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');

const MAX_PROFONDITA = 6;

const tipiPratica = config.studio.pratiche.tipi;
const statiPratica = config.studio.pratiche.stati;

function nascosto(nome) {
  return nome.startsWith('.') || nome.startsWith('_') || nome === 'Thumbs.db' || nome === '@eaDir' || nome === '#recycle';
}

/** Risolve `rel` dentro `base` impedendo di uscirne (../, percorsi assoluti, link simbolici). */
function risolviDentro(base, rel) {
  const baseAbs = path.resolve(base);
  const target = path.resolve(baseAbs, rel || '.');
  if (target !== baseAbs && !target.startsWith(baseAbs + path.sep)) return null;
  // Segue eventuali link simbolici e ricontrolla
  try {
    const realBase = fs.realpathSync(baseAbs);
    const realTarget = fs.realpathSync(target);
    if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) return null;
  } catch {
    // Il file non esiste ancora (es. upload): il controllo lessicale sopra basta
  }
  // Nessun segmento nascosto nel percorso
  const segmenti = path.relative(baseAbs, target).split(path.sep).filter(Boolean);
  if (segmenti.some(nascosto)) return null;
  return target;
}

/** Normalizza il nome cartella inserito dall'amministratore (relativo all'archivio). */
function normalizzaCartella(input) {
  const pulita = String(input || '').replace(/\\/g, '/').split('/').map((s) => s.trim()).filter(Boolean).join('/');
  if (!pulita) return null;
  return risolviDentro(config.archivioDir, pulita) ? pulita : null;
}

function cartellaLavoro(lavoro) {
  return risolviDentro(config.archivioDir, lavoro.cartella);
}

/** Nome valido per una sottocartella-pratica: un solo segmento, non nascosto. */
function nomePraticaValido(nome) {
  const n = String(nome || '');
  return Boolean(n) && n === n.trim() && !/[\\/]/.test(n) && n !== '.' && n !== '..' && !nascosto(n);
}

/** Percorso assoluto della sottocartella di una pratica, o null. */
function cartellaPratica(lavoro, nome) {
  const base = cartellaLavoro(lavoro);
  if (!base || !nomePraticaValido(nome)) return null;
  return risolviDentro(base, nome);
}

/** Crea la cartella del lavoro (le sottocartelle delle pratiche si aggiungono quando servono). */
async function creaStruttura(lavoro) {
  const base = cartellaLavoro(lavoro);
  if (!base) throw new Error('Cartella non valida');
  await fsp.mkdir(base, { recursive: true });
}

/** Crea la sottocartella di una nuova pratica e ne restituisce il nome. */
async function creaCartellaPratica(lavoro, nome) {
  const pulito = nomeSicuro(nome);
  const dir = cartellaPratica(lavoro, pulito);
  if (!dir) throw new Error('Nome pratica non valido');
  await fsp.mkdir(dir, { recursive: true });
  return pulito;
}

/** Elenco delle sottocartelle dirette del lavoro (le pratiche presenti sul NAS). */
async function sottocartelle(lavoro) {
  const base = cartellaLavoro(lavoro);
  if (!base) return [];
  let voci;
  try {
    voci = await fsp.readdir(base, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return [];
    throw e;
  }
  return voci.filter((v) => v.isDirectory() && nomePraticaValido(v.name)).map((v) => v.name)
    .sort((x, y) => x.localeCompare(y, 'it', { numeric: true }));
}

const normalizza = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Posizione del tipo di pratica riconosciuto nel nome della cartella (-1 se nessuno). */
function indiceTipo(nomeCartella) {
  const n = ` ${normalizza(nomeCartella)} `;
  return tipiPratica.findIndex((t) => n.includes(` ${normalizza(t)} `));
}

async function elencaRicorsivo(dir, relBase, profondita, out) {
  if (profondita > MAX_PROFONDITA) return;
  let voci;
  try {
    voci = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  for (const v of voci) {
    if (nascosto(v.name)) continue;
    const abs = path.join(dir, v.name);
    const rel = relBase ? `${relBase}/${v.name}` : v.name;
    if (v.isDirectory()) {
      await elencaRicorsivo(abs, rel, profondita + 1, out);
    } else if (v.isFile()) {
      const st = await fsp.stat(abs);
      out.push({ nome: v.name, percorso: rel, cartella: relBase, dimensione: st.size, modificato: st.mtime });
    }
  }
}

/** File di una pratica (anche nelle sotto-sottocartelle), ordinati per percorso. */
async function documentiPratica(lavoro, nome) {
  const dir = cartellaPratica(lavoro, nome);
  const file = [];
  if (dir) await elencaRicorsivo(dir, '', 0, file);
  file.sort((x, y) => x.percorso.localeCompare(y.percorso, 'it', { numeric: true }));
  return file;
}

/** Percorso assoluto di un file della pratica, o null se non esiste / non è accessibile. */
function fileDocumento(lavoro, nomePratica, rel) {
  const dir = cartellaPratica(lavoro, nomePratica);
  if (!dir || !rel) return null;
  const abs = risolviDentro(dir, rel);
  if (!abs || abs === path.resolve(dir)) return null;
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

/** Nome file sicuro per gli upload. */
function nomeSicuro(nome) {
  const base = path.basename(String(nome || '')).normalize('NFC').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').trim();
  const pulito = base.replace(/^[._]+/, '');
  return pulito.slice(0, 180) || null;
}

/** Sposta un file caricato nella pratica indicata senza sovrascrivere file esistenti. */
async function salvaUpload(lavoro, nomePratica, tmpPath, nomeOriginale) {
  const dir = cartellaPratica(lavoro, nomePratica);
  const nome = nomeSicuro(nomeOriginale);
  if (!dir || !nome) throw new Error('Destinazione non valida');
  await fsp.mkdir(dir, { recursive: true });
  const ext = path.extname(nome);
  const radice = nome.slice(0, nome.length - ext.length);
  let finale = nome;
  for (let i = 2; fs.existsSync(path.join(dir, finale)); i++) finale = `${radice} (${i})${ext}`;
  const dest = path.join(dir, finale);
  try {
    await fsp.rename(tmpPath, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(tmpPath, dest); // tmp e NAS su volumi diversi
    await fsp.unlink(tmpPath);
  }
  return finale;
}

async function eliminaFile(lavoro, nomePratica, rel) {
  const abs = fileDocumento(lavoro, nomePratica, rel);
  if (!abs) return false;
  await fsp.unlink(abs);
  return true;
}

module.exports = {
  tipiPratica,
  statiPratica,
  risolviDentro,
  normalizzaCartella,
  cartellaLavoro,
  cartellaPratica,
  creaStruttura,
  creaCartellaPratica,
  sottocartelle,
  indiceTipo,
  documentiPratica,
  fileDocumento,
  nomeSicuro,
  salvaUpload,
  eliminaFile,
};
