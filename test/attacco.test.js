'use strict';
/**
 * Attacco simulato con la configurazione del server vero (produzione, HTTPS dietro proxy).
 * Ogni prova è un tentativo di violazione: deve fallire.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-attacco-'));
Object.assign(process.env, {
  NODE_ENV: 'production', ARCHIVIO_DIR: path.join(tmp, 'lavori'), DATI_DIR: path.join(tmp, 'app'),
  URL_PUBBLICO: 'https://area.esempio.it', SOLO_AREA: 'true', COOKIE_SECURE: 'true', TRUST_PROXY: 'true',
});
fs.mkdirSync(process.env.ARCHIVIO_DIR, { recursive: true });
const SEGRETO = 'CONTENUTO-SEGRETO-9f3a';
fs.writeFileSync(path.join(tmp, 'fuori.txt'), SEGRETO);

const app = require('../src/server');
const auth = require('../src/auth');
const pubblicati = require('../src/pubblicati');
const contabilita = require('../src/contabilita');
const { db, Utenti, Lavori, Pratiche, Aziende } = require('../src/modelli');

let base; let server; let LA; let LB; let pA; let pB; let pPriv; let notulaId;
const PW = 'PasswordSicura123';
const PDF = '%PDF-1.4\n' + SEGRETO;
let nIp = 10;

function browser(ip) {
  const ipCliente = ip || `198.51.100.${nIp++}`;
  let cookie = '';
  return {
    get cookie() { return cookie; }, set cookie(c) { cookie = c; },
    async go(p, opt = {}) {
      const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-for': ipCliente, ...(opt.headers || {}), cookie };
      const r = await fetch(base + p, { redirect: 'manual', ...opt, headers });
      const sc = r.headers.getSetCookie();
      if (sc.length) cookie = sc.map((x) => x.split(';')[0]).join('; ');
      return { status: r.status, loc: r.headers.get('location'), headers: r.headers, text: await r.text() };
    },
    async csrf(da = '/accedi') { return ((await this.go(da)).text.match(/name="_csrf" value="([^"]+)"/) || [])[1] || ''; },
    async post(p, dati, da = '/accedi') {
      return this.go(p, { method: 'POST', body: new URLSearchParams({ ...dati, _csrf: await this.csrf(da) }) });
    },
    async accedi(email, password = PW) { const r = await this.post('/accedi', { email, password }); assert.strictEqual(r.status, 302, `login ${email}`); return this; },
  };
}

/** Tutte le rotte registrate nell'app: [{metodo, percorso}] */
function rotte() {
  const out = [];
  const visita = (stack, prefisso) => {
    for (const l of stack) {
      if (l.route) for (const m of Object.keys(l.route.methods)) out.push({ metodo: m.toUpperCase(), percorso: prefisso + l.route.path });
      else if (l.handle && l.handle.stack) {
        const m = String(l.regexp || '').match(/\\\/([a-z]+)/i);
        const pre = l.matchers && l.matchers[0] ? null : null;
        visita(l.handle.stack, prefisso + (l.__prefisso || (m ? '/' + m[1] : '')));
      }
    }
  };
  for (const [pre, file] of [['', 'pubblico'], ['/area', 'area'], ['/studio', 'studio']]) visita(require(`../src/routes/${file}`).stack, pre);
  return out;
}
const concreto = (p, l = LA) => p.replace(':id', l).replace(':pid', pA).replace(':tid', 1).replace(':iid', 1).replace(':did', 1).replace(':vid', 1)
  .replace(':rid', 1).replace(':fid', 1).replace(':token', 'x'.repeat(43));

test.before(async () => {
  const h = await auth.hashPassword(PW);
  Utenti.inserisci.run('studio@esempio.it', h, 'Studio', null, 'admin');
  const anna = Number(Utenti.inserisci.run('anna@esempio.it', h, 'Anna', null, 'cliente').lastInsertRowid);
  const bruno = Number(Utenti.inserisci.run('bruno@esempio.it', h, 'Bruno', null, 'cliente').lastInsertRowid);
  const agente = Number(Utenti.inserisci.run('agente@esempio.it', h, 'Agente', null, 'cliente').lastInsertRowid);
  const operaio = Number(Utenti.inserisci.run('impresa@esempio.it', h, 'Impresa', null, 'cliente').lastInsertRowid);
  const mk = (codice, cartella) => Number(Lavori.inserisci.run({ codice, titolo: `Lavoro ${codice}`, descrizione: null, indirizzo: null, stato: 'In corso', cartella, data_inizio: null, data_fine: null, visibile: 1 }).lastInsertRowid);
  LA = mk('A-1', 'A-1 Anna'); LB = mk('B-1', 'B-1 Bruno');
  Lavori.aggiungiCliente.run(LA, anna); Lavori.aggiungiCliente.run(LB, bruno);
  const az = Number(Aziende.inserisci.run({ nome: 'Agenzia X', tipo: 'agenzia', piva: null, email: null, telefono: null }).lastInsertRowid);
  Utenti.impostaAzienda.run(az, agente);
  Lavori.aggiungiAzienda.run(LA, az, 'agenzia', new Date().toISOString());
  Lavori.aggiungiConRuolo.run(LA, operaio, 'impresa', null);
  const dirA = path.join(process.env.ARCHIVIO_DIR, 'A-1 Anna');
  const dirB = path.join(process.env.ARCHIVIO_DIR, 'B-1 Bruno');
  for (const d of [path.join(dirA, 'CILA'), path.join(dirA, 'Contratto'), path.join(dirB, 'SCIA'), path.join(dirA, 'CILA', '_bozze')]) fs.mkdirSync(d, { recursive: true });
  for (const f of [[dirA, 'CILA', 'pubblico.pdf'], [dirA, 'CILA', 'privato.pdf'], [dirA, 'CILA', '_bozze', 'bozza.pdf'], [dirA, 'CILA', '.nascosto.pdf'], [dirA, 'Contratto', 'contratto.pdf'], [dirB, 'SCIA', 'bruno.pdf']]) fs.writeFileSync(path.join(...f), PDF);
  fs.symlinkSync(path.join(tmp, 'fuori.txt'), path.join(dirA, 'CILA', 'collegamento.txt'));
  fs.symlinkSync(tmp, path.join(dirA, 'CILA', 'cartella-link'));
  pA = Number(Pratiche.inserisci.run(LA, 'CILA', 'In corso', 1, 1).lastInsertRowid);
  pPriv = Number(Pratiche.inserisci.run(LA, 'Contratto', 'In corso', 0, 2).lastInsertRowid);
  pB = Number(Pratiche.inserisci.run(LB, 'SCIA', 'In corso', 1, 1).lastInsertRowid);
  Pratiche.visibilitaRuoli.run(1, 0, 0, pA, LA); // CILA: solo proprietario
  const lav = Lavori.perId.get(LA);
  pubblicati.pubblica(lav, { ...Pratiche.perId.get(pA, LA) }, 'pubblico.pdf');
  pubblicati.pubblica(lav, { ...Pratiche.perId.get(pPriv, LA) }, 'contratto.pdf');
  pubblicati.pubblica(Lavori.perId.get(LB), { ...Pratiche.perId.get(pB, LB) }, 'bruno.pdf');
  Lavori.impostaScheda.run(JSON.stringify({ attiva: true }), LA);
  Lavori.impostaScheda.run(JSON.stringify({ attiva: true }), LB);
  notulaId = contabilita.crea({ lavoro_id: LA, dest_nome: 'Anna', dest_indirizzo: '', dest_cf: '', dest_email: 'anna@esempio.it', oggetto: 'IMPORTO-RISERVATO', data: '2026-11-16',
    voci: JSON.stringify([{ d: 'Onorario riservato', c: 987654 }]), spese: '[]', cassa_pct: 5, iva_pct: 22, sostituto: 0, note: '' });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test('matrice completa: nessuna rotta riservata risponde a visitatori, clienti, agenzie o imprese', async () => {
  const tutte = rotte();
  assert.ok(tutte.length > 80, `rotte trovate: ${tutte.length}`);
  const riservate = tutte.filter((r) => r.percorso.startsWith('/studio'));
  const attori = { visitatore: browser() };
  for (const e of ['anna', 'bruno', 'agente', 'impresa']) attori[e] = await browser().accedi(`${e}@esempio.it`);
  for (const [nome, b] of Object.entries(attori)) {
    const tok = await b.csrf(nome === 'visitatore' ? '/accedi' : '/area/profilo');
    for (const r of riservate) {
      const p = concreto(r.percorso).replace('/contabilita/' + LA, '/contabilita/' + notulaId);
      const risp = await b.go(p, r.metodo === 'GET' ? {} : { method: 'POST', body: new URLSearchParams({ _csrf: tok, stato: 'pagata' }) });
      assert.ok([302, 403].includes(risp.status), `${nome} ${r.metodo} ${p} → ${risp.status}`);
      if (risp.status === 302) assert.strictEqual(risp.loc, '/accedi', `${nome} ${p}`);
      assert.ok(!/IMPORTO-RISERVATO|Onorario riservato|9\.876,54/.test(risp.text), `${nome} vede importi su ${p}`);
    }
  }
  // I tentativi non hanno cambiato nulla
  assert.strictEqual(contabilita.Q.perId.get(notulaId).stato, 'bozza');
  assert.strictEqual(Lavori.perId.get(LA).titolo, 'Lavoro A-1');
  assert.strictEqual(Utenti.clienti.all().length, 4);
});

test('contabilità: gli importi non compaiono in nessuna pagina dell\'area clienti né nei dati esportati', async () => {
  for (const e of ['anna', 'agente', 'impresa']) {
    const b = await browser().accedi(`${e}@esempio.it`);
    for (const p of ['/area', `/area/lavori/${LA}`, '/area/profilo', '/area/profilo/dati', `/area/lavori/${LA}/notula.pdf`, `/area/contabilita`, `/area/contabilita/${notulaId}/notula.pdf`]) {
      const t = (await b.go(p)).text;
      assert.ok(!/IMPORTO-RISERVATO|Onorario|987654|9\.876|[Nn]otula|proforma/.test(t), `${e} ${p}`);
    }
  }
});

test('un cliente non raggiunge in nessun modo il lavoro di un altro', async () => {
  const anna = await browser().accedi('anna@esempio.it');
  const tok = await anna.csrf('/area/profilo');
  for (const r of rotte().filter((x) => x.percorso.startsWith('/area/lavori'))) {
    const p = concreto(r.percorso, LB).replace(pA, pB);
    for (const q of ['', `?p=${pB}&f=bruno.pdf`, `?come=proprietario&p=${pB}&f=bruno.pdf`]) {
      const risp = await anna.go(p + q, r.metodo === 'GET' ? {} : { method: 'POST', body: new URLSearchParams({ _csrf: tok }) });
      assert.strictEqual(risp.status, 404, `${r.metodo} ${p}${q} → ${risp.status}`);
      assert.ok(!risp.text.includes(SEGRETO) && !risp.text.includes('Lavoro B-1'));
    }
  }
  // Pratica di Bruno chiesta attraverso il proprio lavoro
  assert.strictEqual((await anna.go(`/area/lavori/${LA}/file?p=${pB}&f=bruno.pdf`)).status, 404);
});

test('agenzia e impresa non salgono di ruolo e non vedono ciò che è del proprietario', async () => {
  for (const e of ['agente', 'impresa']) {
    const b = await browser().accedi(`${e}@esempio.it`);
    for (const come of ['', '&come=proprietario', '&come=admin', '&come[]=proprietario']) {
      const r = await b.go(`/area/lavori/${LA}/file?p=${pA}&f=pubblico.pdf${come}`);
      assert.strictEqual(r.status, 404, `${e} ${come} → ${r.status}`);
    }
    const pagina = (await b.go(`/area/lavori/${LA}?come=proprietario`)).text;
    assert.ok(!pagina.includes('pubblico.pdf'), `${e} vede la CILA`);
    // POST con "come" nel corpo
    const tok = await b.csrf('/area/profilo');
    const up = await b.go(`/area/lavori/${LA}/richieste/1/file`, { method: 'POST', body: new URLSearchParams({ _csrf: tok, come: 'proprietario' }) });
    assert.strictEqual(up.status, 404);
  }
  const imp = await browser().accedi('impresa@esempio.it');
  assert.strictEqual((await imp.go(`/area/lavori/${LA}/fabbricato.pdf`)).status, 404);
  assert.strictEqual((await imp.go(`/area/lavori/${LA}/fascicolo.zip`)).status, 404);
});

test('file: uscita dalla cartella, collegamenti, nascosti, non pubblicati e cartelle private', async () => {
  const anna = await browser().accedi('anna@esempio.it');
  assert.strictEqual((await anna.go(`/area/lavori/${LA}/file?p=${pA}&f=pubblico.pdf`)).status, 200);
  const cattivi = ['privato.pdf', '_bozze/bozza.pdf', '.nascosto.pdf', 'collegamento.txt', 'cartella-link/fuori.txt', '../Contratto/contratto.pdf',
    '..%2FContratto%2Fcontratto.pdf', '..\\Contratto\\contratto.pdf', '....//Contratto/contratto.pdf', '/etc/passwd', '../../../../../../etc/passwd',
    '%2e%2e/%2e%2e/fuori.txt', '..%252f..%252ffuori.txt', 'pubblico.pdf/../privato.pdf', 'pubblico.pdf%00.txt', 'pubblico.pdf\0.txt', './privato.pdf',
    'PUBBLICO.PDF/../../../fuori.txt', '../../B-1 Bruno/SCIA/bruno.pdf', '..', '.', '', 'pubblico.pdf/', 'C:\\Windows\\win.ini', 'file:///etc/passwd', '\u2025/\u2025/fuori.txt', '..;/privato.pdf'];
  for (const f of cattivi) {
    for (const enc of [encodeURIComponent(f), f]) {
      let r;
      try { r = await anna.go(`/area/lavori/${LA}/file?p=${pA}&f=${enc}`); } catch { continue; }
      assert.ok(r.status === 404 || r.status === 400, `f=${JSON.stringify(f)} → ${r.status}`);
      assert.ok(!r.text.includes(SEGRETO), `contenuto uscito con f=${f}`);
    }
  }
  // Cartella non visibile: nemmeno il file "pubblicato" al suo interno
  assert.strictEqual((await anna.go(`/area/lavori/${LA}/file?p=${pPriv}&f=contratto.pdf`)).status, 404);
  // Parametri ripetuti o strutturati
  for (const q of [`p=${pA}&f=privato.pdf&f=pubblico.pdf`, `p=${pA}&f[]=privato.pdf`, `p[]=${pA}&p[]=${pPriv}&f=contratto.pdf`, `p=${pA}%20OR%201=1&f=privato.pdf`, `p=${pPriv}&p=${pA}&f=contratto.pdf`]) {
    const r = await anna.go(`/area/lavori/${LA}/file?${q}`);
    assert.ok(r.status < 500 && !(r.status === 200 && /privato|contratto/.test(q) && r.headers.get('content-disposition')?.match(/privato|contratto/)), `${q} → ${r.status}`);
  }
  // Lo ZIP contiene solo il pubblicato
  const zip = await fetch(`${base}/area/lavori/${LA}/fascicolo.zip`, { headers: { cookie: anna.cookie, 'x-forwarded-proto': 'https' } });
  const buf = Buffer.from(await zip.arrayBuffer()).toString('latin1');
  assert.ok(buf.includes('pubblico.pdf'));
  for (const n of ['privato.pdf', 'bozza.pdf', 'nascosto', 'collegamento', 'contratto.pdf', 'bruno.pdf', 'fuori.txt']) assert.ok(!buf.includes(n), `ZIP contiene ${n}`);
});

test('file statici: niente codice, database o configurazione scaricabili', async () => {
  const b = browser();
  for (const p of ['/.env', '/package.json', '/src/server.js', '/dati/studio.sqlite', '/studio.sqlite', '/.git/config', '/config/studio.json', '/css/..%2f..%2fpackage.json',
    '/js/../../src/db.js', '/css/%2e%2e/%2e%2e/.env', '/img/..\\..\\package.json', '/node_modules/express/package.json', '/views/accedi.ejs', '/Dockerfile', '/backup/', '/dati/', '/server-status', '/.well-known/../.env']) {
    const r = await b.go(p);
    assert.ok(r.status !== 200 || /Area clienti|accedi/i.test(r.text), `${p} → ${r.status}`);
    assert.ok(!/SESSION_SECRET|"dependencies"|require\(|SQLite format|FROM node/.test(r.text), `${p} espone file interni`);
  }
});

test('CSRF: ogni POST dell\'app rifiuta richieste senza token, con token altrui o da altri siti', async () => {
  const studio = await browser().accedi('studio@esempio.it');
  const altro = await browser().csrf();
  const prima = { lavori: Lavori.tutti.all().length, clienti: Utenti.clienti.all().length, notule: contabilita.Q.tutte.all().length };
  for (const r of rotte().filter((x) => x.metodo === 'POST' && x.percorso !== '/configura')) {
    const p = concreto(r.percorso);
    for (const corpo of [{}, { _csrf: altro }, { _csrf: '' }, { _csrf: 'x'.repeat(48) }]) {
      const risp = await studio.go(p, { method: 'POST', body: new URLSearchParams({ ...corpo, nome: 'x', stato: 'pagata', email: 'x@x.it' }), headers: { origin: 'https://sito-cattivo.example' } });
      assert.ok([403, 404, 302, 410].includes(risp.status), `${p} ${JSON.stringify(corpo)} → ${risp.status}`);
      if (risp.status === 302) assert.ok(!/ok/.test(risp.loc || ''), p);
    }
    // multipart senza token
    const fd = new FormData(); fd.append('file', new Blob([PDF]), 'x.pdf'); fd.append('tipo', 'durc');
    const m = await studio.go(p, { method: 'POST', body: fd });
    assert.ok([403, 404, 302, 400, 410].includes(m.status), `multipart ${p} → ${m.status}`);
  }
  assert.deepStrictEqual({ lavori: Lavori.tutti.all().length, clienti: Utenti.clienti.all().length, notule: contabilita.Q.tutte.all().length }, prima);
  assert.strictEqual(contabilita.Q.perId.get(notulaId).stato, 'bozza');
  // Il token non compare negli indirizzi e non funziona via GET
  assert.strictEqual((await studio.go(`/studio/contabilita/${notulaId}/elimina`)).status, 404);
  assert.ok(contabilita.Q.perId.get(notulaId));
});

test('XSS: codice inserito in ogni campo viene mostrato come testo, anche nelle nuove sezioni', async () => {
  const X = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
  const studio = await browser().accedi('studio@esempio.it');
  await studio.post('/studio/contabilita', { dest_nome: X, dest_email: 'x@esempio.it', dest_indirizzo: X, dest_cf: X, oggetto: X, data: '2026-11-16', voce_desc: X, voce_importo: '10', spesa_desc: X, spesa_importo: '1', note: `</textarea>${X}` }, '/studio/contabilita/nuova');
  await studio.post(`/studio/lavori/${LA}/scheda`, { attiva: '1', indirizzo: X, comune: X, catasto: X, descrizione: X, nota: X, apeClasse: X, coordinate: X }, `/studio/lavori/${LA}`);
  await studio.post(`/studio/lavori/${LA}/pratiche/${pA}/tappe`, { fase: 'integrazione', data: '2026-11-01', protocollo: X }, `/studio/lavori/${LA}`);
  await studio.post(`/studio/lavori/${LA}/aggiornamenti`, { testo: X }, `/studio/lavori/${LA}`);
  await studio.post('/studio/aziende', { nome: X, tipo: 'agenzia', email: 'a@esempio.it', piva: X, telefono: X }, '/studio/aziende/nuova');
  db.prepare('UPDATE utenti SET nome = ? WHERE email = ?').run(X, 'bruno@esempio.it');
  db.prepare('UPDATE lavori SET titolo = ?, descrizione = ?, indirizzo = ? WHERE id = ?').run(X, X, X, LB);
  fs.writeFileSync(path.join(process.env.ARCHIVIO_DIR, 'A-1 Anna', 'CILA', '<img src=x onerror=alert(3)>.pdf'), PDF);
  const anna = await browser().accedi('anna@esempio.it');
  const bruno = await browser().accedi('bruno@esempio.it');
  const pagine = [[studio, '/studio'], [studio, '/studio/contabilita'], [studio, `/studio/contabilita/${contabilita.Q.tutte.all()[0].id}`], [studio, `/studio/lavori/${LA}`], [studio, `/studio/lavori/${LB}`],
    [studio, '/studio/clienti'], [studio, '/studio/aziende'], [studio, `/studio/lavori/${LA}/modifica`], [anna, `/area/lavori/${LA}`], [anna, '/area'], [bruno, '/area'], [bruno, `/area/lavori/${LB}`], [bruno, '/area/profilo'],
    [studio, `/studio/lavori/${LA}?x=${encodeURIComponent(X)}`], [anna, `/accedi?email=${encodeURIComponent(X)}`], [anna, `/area/lavori/${LA}?come=${encodeURIComponent(X)}`]];
  for (const [b, p] of pagine) {
    const t = (await b.go(p)).text;
    assert.ok(!/<script>alert|<img src=x onerror/.test(t), `XSS in ${p}`);
  }
  // Pagina di errore e login con payload
  const v = browser();
  for (const p of [`/${encodeURIComponent(X)}`, `/imposta-password/${encodeURIComponent(X)}`]) assert.ok(!/<script>alert/.test((await v.go(p)).text), p);
  const r = await v.post('/accedi', { email: X, password: X });
  assert.ok(!/<script>alert/.test(r.text));
  // Il PDF della notula si genera comunque
  const pdf = await studio.go(`/studio/contabilita/${contabilita.Q.tutte.all()[0].id}/notula.pdf`);
  assert.strictEqual(pdf.status, 200);
  assert.match(pdf.headers.get('content-type'), /application\/pdf/);
  fs.unlinkSync(path.join(process.env.ARCHIVIO_DIR, 'A-1 Anna', 'CILA', '<img src=x onerror=alert(3)>.pdf'));
});

test('SQL injection: login, identificativi e campi di ricerca', async () => {
  const b = browser();
  const tok = await b.csrf();
  const payload = ["' OR '1'='1", "' OR 1=1--", "admin'--", "studio@esempio.it'--", "' UNION SELECT 1,2,3,4,5,6,7,8--", "'; DROP TABLE utenti;--", '" OR ""="', "\\' OR 1=1--", "studio@esempio.it' AND '1'='1"];
  let n = 0;
  for (const e of payload) {
    const bb = browser();
    const r = await bb.post('/accedi', { email: e, password: e });
    assert.strictEqual(r.status, 401, e);
    assert.strictEqual((await bb.go('/studio')).status, 302);
    n++;
  }
  assert.ok(n && Utenti.contaAdmin.get().n === 1 && tok);
  const anna = await browser().accedi('anna@esempio.it');
  for (const id of ["1 OR 1=1", "1;DROP TABLE lavori", `${LB} UNION SELECT 1`, "1'", '0x2', `${LB}.0`, ` ${LB}`, `${LB}e0`, `+${LB}`]) {
    const r = await anna.go(`/area/lavori/${encodeURIComponent(id)}`);
    assert.ok(r.status === 404, `id=${id} → ${r.status}`);
  }
  assert.ok(Lavori.tutti.all().length === 2);
});

test('sessione: cookie falsi, firma sbagliata, fissazione e riuso dopo l\'uscita', async () => {
  const vittima = browser();
  await vittima.go('/accedi');
  const prima = vittima.cookie;
  await vittima.accedi('anna@esempio.it');
  assert.notStrictEqual(vittima.cookie, prima, 'identificativo rigenerato al login');
  // L'attaccante che conosceva il cookie di prima non entra
  const ladro = browser(); ladro.cookie = prima;
  assert.strictEqual((await ladro.go('/area')).status, 302);
  // Cookie manomesso: cambia un carattere dell'identificativo o della firma
  const [nome, val] = vittima.cookie.split('=');
  const dec = decodeURIComponent(val);
  for (const falso of [dec.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')), dec.replace(/^s:./, 's:X'), 's:' + 'a'.repeat(32) + '.' + 'b'.repeat(43), dec.split('.')[0], 'null', '{"utenteId":1}', 'j:{"utenteId":1}']) {
    const f = browser(); f.cookie = `${nome}=${encodeURIComponent(falso)}`;
    assert.strictEqual((await f.go('/area')).status, 302, falso);
    assert.strictEqual((await f.go('/studio')).status, 302, falso);
  }
  // Dopo l'uscita il vecchio cookie è morto
  const vivo = vittima.cookie;
  await vittima.post('/esci', {}, '/area/profilo');
  const dopo = browser(); dopo.cookie = vivo;
  assert.strictEqual((await dopo.go('/area')).status, 302);
  // Nessuna sessione nel database contiene password o hash
  for (const s of db.prepare('SELECT dati FROM sessioni').all()) assert.ok(!/\$2[aby]\$|PasswordSicura/.test(s.dati));
});

test('cambio password: chiude le altre sessioni; i link di reimpostazione non si riusano', async () => {
  const a1 = await browser().accedi('bruno@esempio.it');
  const a2 = await browser().accedi('bruno@esempio.it');
  const r = await a1.post('/area/profilo/password', { attuale: PW, nuova: 'NuovaPassword456!', conferma: 'NuovaPassword456!' }, '/area/profilo');
  assert.match(r.text, /aggiornata/);
  assert.strictEqual((await a2.go('/area')).status, 302, 'l\'altra sessione è stata chiusa');
  assert.strictEqual((await a1.go('/area')).status, 200);
  // Link monouso, anche se usato due volte in parallelo
  const linkPassword = require('../src/link-password');
  const id = Utenti.perEmail.get('bruno@esempio.it').id;
  const token = linkPassword.crea(id, 1, {}).split('/').pop();
  const due = await Promise.all([1, 2].map(async (i) => {
    const b = browser();
    return b.post(`/imposta-password/${token}`, { nuova: `PasswordParallela${i}!`, conferma: `PasswordParallela${i}!` }, `/imposta-password/${token}`);
  }));
  assert.strictEqual(due.filter((x) => x.status === 302).length, 1, `esiti: ${due.map((x) => x.status)}`);
  assert.strictEqual((await browser().go(`/imposta-password/${token}`)).status, 410);
  // Token indovinati
  for (const t of ['a'.repeat(43), token.slice(0, -1) + 'A', token.toUpperCase(), token + '%00', token + '/../' + token]) assert.strictEqual((await browser().go(`/imposta-password/${t}`)).status === 200, false, t);
  // Il token non è salvato in chiaro
  assert.ok(!db.prepare('SELECT impronta FROM link_password').all().some((x) => x.impronta === token));
  db.prepare('UPDATE utenti SET password_hash = ? WHERE id = ?').run(await auth.hashPassword(PW), id);
});

test('forza bruta in parallelo: 60 tentativi contemporanei non provano più di 5 password', async () => {
  const ip = '198.51.100.200';
  const b = browser(ip);
  const tok = await b.csrf();
  let provate = 0;
  const vera = auth.verificaPassword;
  auth.verificaPassword = async (...a) => { provate++; return vera(...a); };
  const pubblico = require('../src/routes/pubblico');
  const esiti = await Promise.all(Array.from({ length: 60 }, (_, i) => b.go('/accedi', { method: 'POST', body: new URLSearchParams({ email: 'anna@esempio.it', password: `tentativo-${i}`, _csrf: tok }) })));
  auth.verificaPassword = vera;
  assert.ok(pubblico && esiti.every((r) => r.status === 401));
  const bloccato = await b.go('/accedi', { method: 'POST', body: new URLSearchParams({ email: 'anna@esempio.it', password: PW, _csrf: tok }) });
  assert.strictEqual(bloccato.status, 401, 'dopo la raffica anche la password giusta è bloccata');
  assert.ok(provate <= 5, `password realmente verificate in raffica: ${provate}`);
});

test('forza bruta: cambiare maiuscole, spazi o X-Forwarded-For non azzera il conteggio', async () => {
  const ip = '198.51.100.201';
  const varianti = ['Agente@esempio.it', 'AGENTE@ESEMPIO.IT', ' agente@esempio.it', 'agente@esempio.it ', 'agente@Esempio.it', 'agente@esempio.it', 'aGente@esempio.it'];
  let entrato = false;
  for (const [i, e] of varianti.entries()) {
    const r = await fetch(`${base}/accedi`, { redirect: 'manual' });
    const c = r.headers.getSetCookie().map((x) => x.split(';')[0]).join('; ');
    const tok = ((await r.text()).match(/name="_csrf" value="([^"]+)"/) || [])[1];
    // L'attaccante aggiunge un indirizzo falso davanti: il proxy vero aggiunge il suo in coda
    const risp = await fetch(`${base}/accedi`, { method: 'POST', redirect: 'manual', headers: { cookie: c, 'x-forwarded-for': `10.0.0.${i}, ${ip}`, 'x-forwarded-proto': 'https' }, body: new URLSearchParams({ email: e, password: i === 6 ? PW : 'sbagliata', _csrf: tok }) });
    if (risp.status === 302) entrato = true;
  }
  assert.strictEqual(entrato, false, 'al settimo tentativo la password giusta non deve passare');
});

test('intestazione Host falsa: nessun link o rimando verso altri domini', async () => {
  const b = browser();
  for (const h of [{ host: 'sito-cattivo.example' }, { 'x-forwarded-host': 'sito-cattivo.example' }, { 'x-original-url': '/studio' }, { 'x-rewrite-url': '/studio' }, { 'x-http-method-override': 'DELETE' }]) {
    for (const p of ['/', '/accedi', '/studio', '/area', '/password-dimenticata']) {
      const r = await b.go(p, { headers: h });
      assert.ok(!/sito-cattivo/.test((r.loc || '') + r.text), `${JSON.stringify(h)} ${p}`);
      if (p === '/studio') assert.strictEqual(r.status, 302);
    }
  }
  // Rimando dopo il login
  for (const d of ['//sito-cattivo.example', '/\\sito-cattivo.example', 'https://sito-cattivo.example', '/%2f%2fsito-cattivo.example', '/area\r\nSet-Cookie: x=1', '/\t/sito-cattivo.example']) {
    const v = browser();
    await v.go(`/studio${d.startsWith('/') ? d : '/' + d}`).catch(() => {});
    const r = await v.post('/accedi', { email: 'studio@esempio.it', password: PW });
    assert.ok(/^\/(?![/\\])/.test(r.loc || '') && !/[\r\n]/.test(r.loc || ''), `${d} → ${r.loc}`);
    assert.ok(!r.headers.get('set-cookie')?.includes('x=1'));
  }
});

test('richieste deformi: nessun errore 500 e nessun dettaglio tecnico nelle risposte', async () => {
  const studio = await browser().accedi('studio@esempio.it');
  const anna = await browser().accedi('anna@esempio.it');
  const tokS = await studio.csrf('/studio'); const tokA = await anna.csrf('/area/profilo');
  const corpi = [
    (t) => new URLSearchParams([['_csrf', t], ['attuale', 'a'], ['attuale', 'b'], ['nuova', 'x'], ['nuova', 'y'], ['conferma', 'z']]),
    (t) => new URLSearchParams([['_csrf', t], ['email', 'a'], ['email', 'b'], ['nome', 'a'], ['nome', 'b'], ['data', 'x'], ['data', 'y'], ['stato', 'a'], ['stato', 'b'], ['fase', 'a'], ['fase', 'b'], ['testo', 'a'], ['testo', 'b'], ['titolo', 'a'], ['titolo', 'b'], ['codice', 'a'], ['codice', 'b'], ['cartella', 'a'], ['cartella', 'b'], ['voce_importo', '1e999'], ['cassa_pct', 'NaN'], ['iva_pct', '-1'], ['lavoro_id', '9e99'], ['dest_nome', 'a'], ['dest_nome', 'b'], ['p', 'a'], ['p', 'b'], ['f', 'a'], ['f', 'b'], ['chiave', 'a'], ['chiave', 'b'], ['unita', 'a'], ['unita', 'b'], ['tipo', 'a'], ['tipo', 'b'], ['ruolo', 'a'], ['ruolo', 'b'], ['impresa', 'a'], ['impresa', 'b'], ['azione', 'a'], ['azione', 'b']]),
    (t) => new URLSearchParams({ _csrf: t, nome: '\u0000\uffff\ud83d', email: 'a@b.c\r\nBcc: x@y.z', data: '9999-99-99', dest_email: 'a@b.it\r\nBcc: spia@x.it', dest_nome: 'x', voce_desc: 'x', voce_importo: '-999999999999999999', '__proto__[admin]': '1', 'constructor[prototype][admin]': '1' }),
    (t) => `_csrf=${t}&` + 'a='.padEnd(150000, 'x'),
    (t) => `_csrf=${t}&` + Array.from({ length: 3000 }, (_, i) => `k${i}=1`).join('&'),
    () => '%%%=%%%&_csrf=%ZZ',
  ];
  const tutte = rotte();
  let n = 0;
  for (const r of tutte) {
    const eStudio = r.percorso.startsWith('/studio');
    const b = eStudio ? studio : anna; const t = eStudio ? tokS : tokA;
    const p = concreto(r.percorso);
    if (/\/esci|elimina|reimposta|sblocca/.test(p)) continue;
    if (r.metodo === 'GET') {
      for (const q of ['?p[]=1&f[]=x&come[]=a&lavoro[]=1&scarica[]=1&tipo[]=x', '?p=%00&f=%ff&lavoro=1e999', '?' + 'a'.repeat(7000)]) {
        const risp = await b.go(p + q); n++;
        assert.ok(risp.status < 500, `GET ${p}${q.slice(0, 40)} → ${risp.status}`);
        assert.ok(!/at .*\.js:\d+|node_modules|SQLITE|\/home\/claude|\/usr\/src|Error:/.test(risp.text), `dettagli tecnici in ${p}`);
      }
    } else {
      for (const c of corpi) {
        const risp = await b.go(p, { method: 'POST', body: c(t), headers: { 'content-type': 'application/x-www-form-urlencoded' } }); n++;
        assert.ok(risp.status < 500, `POST ${p} corpo#${corpi.indexOf(c)} → ${risp.status}`);
        assert.ok(!/at .*\.js:\d+|node_modules|SQLITE|\/home\/claude|Error:/.test(risp.text), `dettagli tecnici in ${p}`);
      }
      for (const [ct, body] of [['application/json', '{"_csrf":"x","__proto__":{"admin":true}}'], ['text/xml', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>'], ['multipart/form-data; boundary=x', '--x\r\nContent-Disposition: form-data; name="file"; filename="../../../x.pdf"\r\n\r\nrotto']]) {
        const risp = await b.go(p, { method: 'POST', body, headers: { 'content-type': ct } }); n++;
        assert.ok(risp.status < 500, `POST ${p} ${ct} → ${risp.status}`);
        assert.ok(!risp.text.includes('root:'), 'XXE');
      }
    }
  }
  assert.ok(n > 500, `richieste inviate: ${n}`);
  for (const m of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE', 'PROPFIND']) {
    let r; try { r = await studio.go(`/studio/lavori/${LA}`, { method: m }); } catch { continue; }
    assert.ok(r.status === 404 || r.status === 405 || r.status === 403 || (m === 'OPTIONS' && r.status < 500), `${m} → ${r.status}`);
  }
  assert.strictEqual(({}).admin, undefined, 'prototype pollution');
  assert.strictEqual(Lavori.perId.get(LA).codice, 'A-1');
  assert.strictEqual((await studio.go('/studio')).status, 200, 'il server risponde ancora');
  // Nessuna cartella creata fuori dall'archivio, nessun file temporaneo rimasto
  assert.ok(!fs.existsSync(path.join(tmp, 'x.pdf')));
  await new Promise((x) => setTimeout(x, 200));
  assert.deepStrictEqual(fs.readdirSync(path.join(process.env.DATI_DIR, 'tmp')), [], 'file temporanei rimasti');
});

test('notule: l\'indirizzo del destinatario non può aggiungere destinatari nascosti', async () => {
  const posta = require('../src/posta');
  const inviate = [];
  Object.assign(posta, { ammAttiva: true, inviaAmministrazione: async (m) => { inviate.push(m); return true; } });
  const studio = await browser().accedi('studio@esempio.it');
  for (const e of ['a@b.it\r\nBcc: spia@x.it', 'a@b.it, spia@x.it', 'a@b.it;spia@x.it', 'a@b.it%0aBcc:spia@x.it', 'spia@x.it\na@b.it', '<a@b.it> spia@x.it']) {
    db.prepare('UPDATE notule SET dest_email = ? WHERE id = ?').run(e, notulaId);
    await studio.post(`/studio/contabilita/${notulaId}/invia`, {}, `/studio/contabilita/${notulaId}`);
  }
  for (const m of inviate) assert.ok(!/[\s,;<>]/.test(m.a) && (m.a.match(/@/g) || []).length === 1, `destinatario ambiguo: ${JSON.stringify(m.a)}`);
  for (const m of inviate) assert.ok(!/[\r\n]/.test(m.oggetto));
});

test('intestazioni e cookie in ogni risposta, comprese quelle di errore', async () => {
  const b = await browser().accedi('anna@esempio.it');
  for (const p of ['/accedi', '/area', `/area/lavori/${LA}`, '/non-esiste', `/area/lavori/${LA}/file?p=${pA}&f=pubblico.pdf&scarica=1`, '/css/style.css', '/%E0%A4%A']) {
    const r = await b.go(p);
    assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff', p);
    assert.ok(r.headers.get('strict-transport-security'), `HSTS ${p}`);
    assert.ok(!r.headers.get('x-powered-by') && !/express/i.test(r.headers.get('server') || ''), p);
    assert.ok(/frame-ancestors|SAMEORIGIN/.test((r.headers.get('content-security-policy') || '') + r.headers.get('x-frame-options')), p);
    if (!p.startsWith('/css')) assert.ok(!/public/.test(r.headers.get('cache-control') || ''), `cache pubblica su ${p}`);
  }
  const v = browser();
  const r = await fetch(`${base}/accedi`, { headers: { 'x-forwarded-proto': 'https' } });
  const sc = r.headers.getSetCookie().join(';');
  assert.match(sc, /HttpOnly/i); assert.match(sc, /Secure/i); assert.match(sc, /SameSite=Lax/i);
  assert.ok(v);
});
