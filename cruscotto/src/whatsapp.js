'use strict';
/**
 * Importazione automatica delle chat WhatsApp.
 *
 * Ogni sera il geometra esporta dal telefono le chat ("Esporta chat" → Drive) nella cartella
 * "Studio Innocenti/_WhatsApp da importare". Il cruscotto controlla la cartella ogni pochi minuti:
 *  - legge i file .txt o .zip, collega ogni chat a un cliente (dal nome o dal numero);
 *  - salva solo i messaggi nuovi (si può riesportare la chat intera ogni volta, senza doppioni);
 *  - sposta il file in "Importate/AAAA-MM-GG";
 *  - se l'ultimo messaggio è del cliente, la chat va tra quelle da rispondere e l'AI prepara riassunto e bozza.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const config = require('./config');
const cartelle = require('./cartelle');
const ai = require('./ai');
const F = require('./formato');
const L = require('./whatsapp-lettore');
const { Clienti, Pratiche, Scadenze, Attivita, Whatsapp, Impostazioni } = require('./modelli');

const W = config.whatsapp;
const CARTELLA_IMPORTATE = 'Importate';
const MAX_DIMENSIONE = 50 * 1024 * 1024;
const BOZZE_PER_GIRO = 10;
let inCorso = null;
let timer = null;

function cartellaImport() {
  if (!cartelle.attiva()) return null;
  return cartelle.risolvi(W.cartella);
}

// ---------- Chi sono "io" nelle chat ----------
function mieiNomi() {
  const appresi = JSON.parse(Impostazioni.leggi('whatsapp_miei_nomi') || '[]');
  return new Set([...W.mieiNomi, ...appresi].map(L.normalizzaNome).filter(Boolean));
}
/** In una chat a due, chi non è il contatto della chat sono io: lo ricordo per le altre chat. */
function imparaMioNome(nomeChat, autori) {
  const contatto = L.normalizzaNome(nomeChat);
  const diversi = [...new Set(autori)];
  if (diversi.length !== 2 || !diversi.some((a) => L.normalizzaNome(a) === contatto)) return;
  const io = diversi.find((a) => L.normalizzaNome(a) !== contatto);
  const appresi = new Set(JSON.parse(Impostazioni.leggi('whatsapp_miei_nomi') || '[]'));
  if (!appresi.has(io)) {
    appresi.add(io);
    Impostazioni.scrivi('whatsapp_miei_nomi', JSON.stringify([...appresi]));
  }
}

// ---------- Collegamento al cliente ----------
const soloCifre = (t) => F.telefonoWhatsapp(t) || null;

function trovaCliente(nomeChat, telefono) {
  const clienti = Clienti.tutti.all();
  if (telefono) {
    const t = soloCifre(`+${telefono}`);
    const c = clienti.find((x) => x.telefono && soloCifre(x.telefono) === t);
    if (c) return c;
  }
  const n = L.normalizzaNome(nomeChat);
  if (!n) return null;
  const esatto = clienti.find((x) => L.normalizzaNome(x.nome) === n);
  if (esatto) return esatto;
  // "Rossi Mario" ↔ "Mario Rossi", "Mario Rossi Montevarchi" ↔ "Mario Rossi": tutte le parole del nome più corto nell'altro
  const parole = new Set(n.split(' '));
  const candidati = clienti.filter((x) => {
    const pc = L.normalizzaNome(x.nome).split(' ').filter(Boolean);
    if (pc.length < 2) return false;
    const [corto, lungo] = pc.length <= parole.size ? [pc, parole] : [[...parole], new Set(pc)];
    return corto.length >= 2 && corto.every((p) => lungo.has(p));
  });
  return candidati.length === 1 ? candidati[0] : null;
}

// ---------- Lettura dei file ----------
function testoDaFile(abs) {
  if (fs.statSync(abs).size > MAX_DIMENSIONE) throw new Error('file troppo grande (esporta la chat "senza media")');
  if (!/\.zip$/i.test(abs)) return fs.readFileSync(abs, 'utf8');
  const voci = new AdmZip(abs).getEntries().filter((e) => !e.isDirectory && /\.txt$/i.test(e.entryName));
  const scelta = voci.find((e) => /chat/i.test(path.basename(e.entryName))) || voci[0];
  if (!scelta) throw new Error('nello zip non c\'è il testo della chat');
  return scelta.getData().toString('utf8');
}

function importaTesto(nomeFile, testo) {
  const nome = L.nomeDaFile(nomeFile);
  const messaggi = L.leggiChat(testo);
  if (!nome || !messaggi.length) throw new Error('non sembra una chat esportata da WhatsApp');
  const telefono = L.telefonoDaNome(nome);

  let chat = Whatsapp.perNome.get(nome);
  if (!chat) {
    const cliente = trovaCliente(nome, telefono);
    const { lastInsertRowid } = Whatsapp.inserisci.run(nome, telefono, cliente?.id ?? null);
    chat = Whatsapp.perNome.get(nome);
    chat.id = Number(lastInsertRowid);
  } else if (!chat.cliente_id) {
    const cliente = trovaCliente(nome, telefono); // magari il cliente è stato aggiunto dopo
    if (cliente) Whatsapp.collega.run(cliente.id, chat.id);
  }

  imparaMioNome(nome, messaggi.map((m) => m.autore));
  const io = mieiNomi();
  const occorrenze = new Map();
  let nuovi = 0;
  for (const m of messaggi) {
    const chiave = `${m.data}|${m.autore}|${m.testo}`;
    const n = (occorrenze.get(chiave) || 0) + 1;
    occorrenze.set(chiave, n);
    const impronta = crypto.createHash('sha1').update(`${chat.id}|${chiave}|${n}`).digest('hex');
    const r = Whatsapp.inserisciMsg.run(chat.id, m.data, m.autore, io.has(L.normalizzaNome(m.autore)) ? 1 : 0, m.testo, impronta);
    nuovi += r.changes;
  }
  for (const a of new Set(messaggi.map((m) => m.autore))) Whatsapp.ricalcolaMio.run(io.has(L.normalizzaNome(a)) ? 1 : 0, chat.id, a);

  const ultimo = Whatsapp.ultimoMsg.get(chat.id);
  const attuale = Whatsapp.perId.get(chat.id);
  const stato = nuovi ? (ultimo.mio ? 'gestita' : 'da_rispondere') : attuale.stato;
  Whatsapp.dopoImport.run({ id: chat.id, ultimo: ultimo.data, stato });
  return { chatId: chat.id, nome, nuovi, daRispondere: stato === 'da_rispondere' };
}

async function spostaInImportate(dir, abs) {
  const giorno = F.oggi();
  const dest = path.join(dir, CARTELLA_IMPORTATE, giorno);
  await fsp.mkdir(dest, { recursive: true });
  const nome = path.basename(abs);
  const ext = path.extname(nome);
  let target = path.join(dest, nome);
  for (let i = 2; fs.existsSync(target); i++) target = path.join(dest, `${nome.slice(0, -ext.length || undefined)} (${i})${ext}`);
  await fsp.rename(abs, target);
}

// ---------- Bozze ----------
const statiChiusi = () => config.studio.pratiche.statiChiusi;

async function preparaBozza(chatId, istruzioni = '') {
  const chat = Whatsapp.perId.get(chatId);
  if (!chat) return null;
  const pratiche = chat.cliente_id ? Pratiche.perCliente.all(chat.cliente_id).filter((p) => !statiChiusi().includes(p.stato)) : [];
  const unica = pratiche.length === 1 ? pratiche[0] : null;
  const r = await ai.generaRispostaWhatsapp({
    chat,
    messaggi: Whatsapp.messaggi.all(chatId, 40),
    pratica: unica,
    scadenze: unica ? Scadenze.perPratica.all(unica.id) : [],
    attivita: unica ? Attivita.perPratica.all(unica.id) : [],
    pratiche,
    istruzioni,
  });
  Whatsapp.salvaBozza.run({ id: chatId, riassunto: r.riassunto, bozza_testo: r.testo, serve: r.serve_risposta ? 1 : 0 });
  return r;
}

function bozzaAutomatica(chat) {
  const modo = config.posta.bozzeAutomatiche;
  if (modo === 'no' || !ai.attiva()) return false;
  return modo === 'tutte' || Boolean(chat.cliente_id);
}

// ---------- Controllo della cartella ----------
async function eseguiImport() {
  const dir = cartellaImport();
  if (!dir) return { file: 0, chat: 0, nuovi: 0, errori: [], cartella: false };
  await fsp.mkdir(dir, { recursive: true });
  const voci = (await fsp.readdir(dir, { withFileTypes: true })).filter((v) => v.isFile() && /\.(txt|zip)$/i.test(v.name) && !v.name.startsWith('.'));
  const risultati = [];
  const errori = [];
  for (const v of voci) {
    const abs = path.join(dir, v.name);
    try {
      risultati.push(importaTesto(v.name, testoDaFile(abs)));
      await spostaInImportate(dir, abs);
    } catch (e) {
      errori.push(`${v.name}: ${e.message}`);
    }
  }
  let bozze = 0;
  for (const r of risultati.filter((x) => x.daRispondere && x.nuovi).slice(0, BOZZE_PER_GIRO)) {
    const chat = Whatsapp.perId.get(r.chatId);
    if (!bozzaAutomatica(chat)) continue;
    try { await preparaBozza(r.chatId); bozze++; } catch (e) { Whatsapp.erroreAi.run(e.message, r.chatId); }
  }
  return { file: risultati.length, chat: new Set(risultati.map((r) => r.chatId)).size, nuovi: risultati.reduce((t, r) => t + r.nuovi, 0), bozze, errori, cartella: true };
}

function importa() {
  if (!inCorso) {
    inCorso = eseguiImport()
      .then((r) => {
        Impostazioni.scrivi('whatsapp_ultimo_controllo', new Date().toISOString());
        Impostazioni.scrivi('whatsapp_errori', r.errori.length ? r.errori.join('\n') : null);
        return r;
      })
      .finally(() => { inCorso = null; });
  }
  return inCorso;
}

function stato() {
  cartelle.ricarica();
  const dir = cartellaImport();
  return {
    attiva: Boolean(dir),
    cartella: W.cartella,
    percorso: dir,
    minuti: W.minuti,
    ultimoControllo: Impostazioni.leggi('whatsapp_ultimo_controllo'),
    errori: Impostazioni.leggi('whatsapp_errori'),
    mieiNomi: [...new Set([...W.mieiNomi, ...JSON.parse(Impostazioni.leggi('whatsapp_miei_nomi') || '[]')])],
  };
}

function avvia() {
  if (timer) return;
  const giro = () => { cartelle.ricarica(); importa().catch((e) => console.error('[whatsapp]', e.message)); };
  setTimeout(giro, 5000).unref();
  timer = setInterval(giro, W.minuti * 60_000);
  timer.unref();
}

module.exports = { importa, importaTesto, preparaBozza, trovaCliente, stato, avvia, testoDaFile };
