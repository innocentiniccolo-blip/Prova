'use strict';
/**
 * Accesso all'archivio lavori sul NAS.
 *
 * Ogni lavoro ha una cartella (relativa ad ARCHIVIO_DIR). Al cliente vengono
 * mostrate SOLO le sottocartelle elencate in config/studio.json → "categorie".
 * Tutto il resto della cartella (es. "Interno", bozze, corrispondenza) resta privato.
 * File e cartelle che iniziano con "." o "_" sono sempre nascosti (utile per le bozze).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');

const MAX_PROFONDITA = 6;

const categorie = config.studio.categorie;
const categoriaPerChiave = new Map(categorie.map((c) => [c.chiave, c]));

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

function cartellaCategoria(lavoro, chiave) {
  const cat = categoriaPerChiave.get(chiave);
  const base = cartellaLavoro(lavoro);
  if (!cat || !base) return null;
  return risolviDentro(base, cat.cartella);
}

/** Crea la cartella del lavoro con tutte le sottocartelle-categoria. */
async function creaStruttura(lavoro) {
  const base = cartellaLavoro(lavoro);
  if (!base) throw new Error('Cartella non valida');
  await fsp.mkdir(base, { recursive: true });
  for (const c of categorie) await fsp.mkdir(path.join(base, c.cartella), { recursive: true });
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

/** Restituisce le categorie del lavoro con l'elenco dei file di ciascuna. */
async function documentiLavoro(lavoro) {
  const risultato = [];
  for (const c of categorie) {
    const dir = cartellaCategoria(lavoro, c.chiave);
    const file = [];
    if (dir) await elencaRicorsivo(dir, '', 0, file);
    file.sort((a, b) => a.percorso.localeCompare(b.percorso, 'it', { numeric: true }));
    risultato.push({ ...c, file });
  }
  return risultato;
}

/** Percorso assoluto di un file del lavoro, o null se non esiste / non è accessibile. */
function fileDocumento(lavoro, chiave, rel) {
  const dir = cartellaCategoria(lavoro, chiave);
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

/** Sposta un file caricato nella categoria indicata senza sovrascrivere file esistenti. */
async function salvaUpload(lavoro, chiave, tmpPath, nomeOriginale) {
  const dir = cartellaCategoria(lavoro, chiave);
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

async function eliminaFile(lavoro, chiave, rel) {
  const abs = fileDocumento(lavoro, chiave, rel);
  if (!abs) return false;
  await fsp.unlink(abs);
  return true;
}

module.exports = {
  categorie,
  categoriaPerChiave,
  risolviDentro,
  normalizzaCartella,
  cartellaLavoro,
  creaStruttura,
  documentiLavoro,
  fileDocumento,
  nomeSicuro,
  salvaUpload,
  eliminaFile,
};
