'use strict';
/**
 * Cartelle delle pratiche su Google Drive.
 *
 * Il cruscotto lavora sulla cartella "Studio Innocenti" che Google Drive per desktop mostra sul PC
 * (di solito G:\Il mio Drive\Studio Innocenti): quello che si crea o si carica qui finisce su Drive
 * da solo, e viceversa. Ogni pratica indica la sua cartella con un percorso relativo, ad esempio
 * "Sofia Forzini" oppure "Sofia Forzini/006-SCIA prot.10912".
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = require('./config');

const MAX_VOCI = 800;
const MAX_PROFONDITA = 4;

/** Percorsi tipici di Google Drive per desktop (Windows e Mac). */
function candidati(nomeCartella) {
  const out = [];
  if (process.platform === 'win32') {
    for (const lettera of 'GHIJKLMNOPQRSTUVWXYZDEF') {
      for (const radice of ['Il mio Drive', 'My Drive']) out.push(`${lettera}:\\${radice}\\${nomeCartella}`);
    }
  } else if (process.platform === 'darwin') {
    const cloud = path.join(os.homedir(), 'Library', 'CloudStorage');
    try {
      for (const d of fs.readdirSync(cloud)) {
        if (d.startsWith('GoogleDrive')) for (const r of ['Il mio Drive', 'My Drive']) out.push(path.join(cloud, d, r, nomeCartella));
      }
    } catch { /* Drive non installato */ }
  }
  return out;
}

function trovaBase() {
  const nome = config.drive.nomeCartella;
  const scelte = config.drive.dir ? [config.drive.dir] : candidati(nome);
  for (const c of scelte) {
    try { if (fs.statSync(c).isDirectory()) return path.resolve(c); } catch { /* prossimo */ }
  }
  return null;
}

let base = trovaBase();
/** Ricontrolla (es. Google Drive avviato dopo il cruscotto). */
function ricarica() { base = trovaBase(); return base; }
const attiva = () => Boolean(base);
const radice = () => base;

const nascosto = (nome) => nome.startsWith('.') || nome.startsWith('~$') || ['desktop.ini', 'Thumbs.db', '.DS_Store'].includes(nome);

/** Percorso relativo pulito ("Sofia Forzini/006-SCIA"), o null se non valido. */
function normalizza(input) {
  const segmenti = String(input || '').replace(/\\/g, '/').split('/').map((s) => s.trim()).filter(Boolean);
  if (!segmenti.length || segmenti.some((s) => s === '.' || s === '..' || /[<>:"|?*\x00-\x1f]/.test(s))) return null;
  return segmenti.join('/');
}

/** Risolve un percorso relativo dentro la cartella dello studio, senza poterne uscire (anche con link simbolici). */
function risolvi(rel) {
  if (!base) return null;
  const target = path.resolve(base, rel || '.');
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  try {
    const realBase = fs.realpathSync(base);
    const realTarget = fs.realpathSync(target);
    if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) return null;
  } catch { /* non esiste ancora: basta il controllo sopra */ }
  return target;
}

/** Cartelle di primo livello (una per cliente/lavoro), le più recenti prima. */
async function cartelleStudio() {
  if (!base) return [];
  const voci = await fsp.readdir(base, { withFileTypes: true }).catch(() => []);
  const dirs = [];
  for (const v of voci) {
    if (!v.isDirectory() || nascosto(v.name) || v.name.startsWith('_')) continue;
    const st = await fsp.stat(path.join(base, v.name)).catch(() => null);
    dirs.push({ nome: v.name, modificato: st ? st.mtimeMs : 0 });
  }
  return dirs.sort((a, b) => b.modificato - a.modificato).map((d) => d.nome);
}

function esiste(rel) {
  const abs = rel ? risolvi(rel) : null;
  try { return Boolean(abs && fs.statSync(abs).isDirectory()); } catch { return false; }
}

/**
 * Contenuto della cartella di una pratica, come albero: [{ nome, percorso, cartella, dimensione, modificato, figli }].
 * Le cartelle prima, in ordine alfabetico (così 001-, 002-… restano in fila); i file per data, i più recenti prima.
 */
async function contenuto(rel) {
  const abs = risolvi(rel);
  if (!abs) return { voci: [], troppi: false };
  let conta = 0;
  async function leggi(dir, relDir, profondita) {
    if (profondita > MAX_PROFONDITA || conta > MAX_VOCI) return [];
    const voci = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const cartelle = [];
    const file = [];
    for (const v of voci) {
      if (nascosto(v.name) || conta > MAX_VOCI) continue;
      conta++;
      const p = relDir ? `${relDir}/${v.name}` : v.name;
      const st = await fsp.stat(path.join(dir, v.name)).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) cartelle.push({ nome: v.name, percorso: p, cartella: true, figli: await leggi(path.join(dir, v.name), p, profondita + 1) });
      else file.push({ nome: v.name, percorso: p, cartella: false, dimensione: st.size, modificato: st.mtime });
    }
    cartelle.sort((a, b) => a.nome.localeCompare(b.nome, 'it', { numeric: true }));
    file.sort((a, b) => b.modificato - a.modificato);
    return [...cartelle, ...file];
  }
  const voci = await leggi(abs, '', 1);
  return { voci, troppi: conta > MAX_VOCI };
}

/** Crea la cartella (ed eventualmente le sottocartelle standard dello studio). */
async function crea(rel, conSottocartelle) {
  const abs = risolvi(rel);
  if (!abs) throw new Error('Nome cartella non valido.');
  await fsp.mkdir(abs, { recursive: true });
  if (conSottocartelle) {
    for (const s of config.studio.sottocartelle || []) await fsp.mkdir(path.join(abs, s), { recursive: true });
  }
  return abs;
}

/** Nome di file sicuro per Windows e Drive. */
function nomeFile(nome) {
  const pulito = path.basename(String(nome || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  return pulito.slice(0, 200) || 'file';
}

/** Sposta un file caricato nella cartella indicata, senza sovrascrivere ("nome (2).pdf"). */
async function salva(relCartella, tmp, nomeOriginale) {
  const dir = risolvi(relCartella);
  if (!dir) throw new Error('Cartella non valida.');
  await fsp.mkdir(dir, { recursive: true });
  const nome = nomeFile(nomeOriginale);
  const ext = path.extname(nome);
  const radiceNome = nome.slice(0, nome.length - ext.length);
  let dest = path.join(dir, nome);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, `${radiceNome} (${i})${ext}`);
  await fsp.copyFile(tmp, dest, fs.constants.COPYFILE_EXCL);
  return path.basename(dest);
}

/** Apre una cartella in Esplora risorse (o un file con il suo programma: PDF, DWG, Excel…). */
function apri(rel) {
  const abs = risolvi(rel);
  if (!abs || !fs.existsSync(abs)) return false;
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [abs]]
    : process.platform === 'darwin' ? ['open', [abs]] : ['xdg-open', [abs]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false }).on('error', () => {}).unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = { attiva, radice, ricarica, normalizza, risolvi, cartelleStudio, esiste, contenuto, crea, salva, apri, nomeFile };
