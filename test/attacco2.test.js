'use strict';
/**
 * Attacco alle novità: link di caricamento delle imprese, risposte email, documenti da controllare,
 * promemoria, WhatsApp/telefono, modulo clienti del lavoro, contabilità, riepiloghi. Tutti dati inventati.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-attacco2-'));
process.env.ARCHIVIO_DIR = path.join(tmp, 'lavori');
process.env.DATI_DIR = path.join(tmp, 'app');
process.env.POSTA_CARTELLA = path.join(tmp, 'posta');
fs.mkdirSync(process.env.ARCHIVIO_DIR, { recursive: true });

const app = require('../src/server');
const auth = require('../src/auth');
const imprese = require('../src/imprese');
const arrivi = require('../src/arrivi');
const postaIn = require('../src/posta-in-arrivo');
const contabilita = require('../src/contabilita');
const { simpleParser } = require('mailparser');
const { Utenti, Lavori } = require('../src/modelli');

const PW = 'PasswordSicura123';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
let base; let server; let adminId; let clienteId;
const nuova = (d = {}) => Number(imprese.Q.inserisci.run({ ragione_sociale: 'Edile Bersaglio srl', piva: null, sede: null, pec: null, email: null, telefono: null, autonomo: 0, nota: null, ...d }).lastInsertRowid);

function browser() {
  let cookie = '';
  return {
    async go(p, opt = {}) {
      const r = await fetch(base + p, { redirect: 'manual', ...opt, headers: { ...(opt.headers || {}), cookie } });
      const sc = r.headers.getSetCookie();
      if (sc.length) cookie = sc.map((s) => s.split(';')[0]).join('; ');
      return { status: r.status, loc: r.headers.get('location'), testo: await r.text(), headers: r.headers };
    },
    async csrf(p) { return ((await this.go(p)).testo.match(/name="_csrf" value="([^"]+)"/) || [])[1] || ''; },
    async post(p, dati, da) { return this.go(p, { method: 'POST', body: new URLSearchParams({ ...dati, _csrf: await this.csrf(da) }) }); },
    async carica(p, files, da, extra = {}) {
      const fd = new FormData();
      fd.append('_csrf', await this.csrf(da));
      for (const [k, v] of Object.entries(extra)) fd.append(k, v);
      for (const [nome, buf] of files) fd.append('file', new Blob([buf]), nome);
      return this.go(p, { method: 'POST', body: fd });
    },
  };
}
function email({ da, oggetto, allegati = [], extraHeader = '' }) {
  const b = 'BNDRY';
  const parti = allegati.map(([nome, buf, tipo]) => [`--${b}`, `Content-Type: ${tipo}; name="${nome}"`, `Content-Disposition: attachment; filename="${nome}"`,
    'Content-Transfer-Encoding: base64', '', buf.toString('base64')].join('\r\n'));
  return [`From: ${da}`, 'To: info@esempio.it', `Subject: ${oggetto}`, ...(extraHeader ? [extraHeader] : []), 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${b}"`, '',
    `--${b}`, 'Content-Type: text/plain', '', 'x', ...parti, `--${b}--`, ''].join('\r\n');
}

let st; let cli;
test.before(async () => {
  const h = await auth.hashPassword(PW);
  adminId = Number(Utenti.inserisci.run('studio@esempio.it', h, 'Studio', null, 'admin').lastInsertRowid);
  clienteId = Number(Utenti.inserisci.run('anna@esempio.it', h, 'Anna "><script>alert(1)</script>', '333 1112222', 'cliente').lastInsertRowid);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  st = browser(); await st.post('/accedi', { email: 'studio@esempio.it', password: PW }, '/accedi');
  cli = browser(); await cli.post('/accedi', { email: 'anna@esempio.it', password: PW }, '/accedi');
});
test.after(() => server && server.close());

// ---------------- Link di caricamento ----------------
test('link: token inventati, troncati, con caratteri strani o di un\'altra impresa non aprono niente', async () => {
  const anon = browser();
  for (const t of ['', 'a', 'x'.repeat(43), '../../etc/passwd', '%00', 'A'.repeat(500), "' OR 1=1 --", '<script>']) {
    const r = await anon.go(`/carica/${encodeURIComponent(t)}`);
    assert.ok([404, 410].includes(r.status), `${t} → ${r.status}`);
    assert.ok(!/Edile Bersaglio/.test(r.testo));
  }
  // token valido ma impresa eliminata
  const id = nuova();
  const url = arrivi.creaLink(id).replace(/^https?:\/\/[^/]+/, '');
  imprese.Q.elimina ? imprese.Q.elimina.run(id) : require('../src/db').prepare('DELETE FROM imprese WHERE id = ?').run(id);
  assert.strictEqual((await anon.go(url)).status, 410);
});

test('link scaduto: non vale più', async () => {
  const id = nuova();
  const url = arrivi.creaLink(id).replace(/^https?:\/\/[^/]+/, '');
  require('../src/db').prepare('UPDATE link_caricamento SET scade = ?').run(Date.now() - 1000);
  assert.strictEqual((await browser().go(url)).status, 410);
});

test('caricamento: nomi con percorsi, script, null byte, doppia estensione, file finti e troppi file', async () => {
  arrivi.azzeraInvii();
  const id = nuova();
  const url = arrivi.creaLink(id).replace(/^https?:\/\/[^/]+/, '');
  const b = browser();
  const r = await b.carica(url, [
    ['../../../../app/dati/studio.db.pdf', PDF],
    ['<img src=x onerror=alert(1)>.pdf', PDF],
    ['fattura.pdf.html', Buffer.from('<html><script>alert(1)</script>')],
    ['finto.png', Buffer.from('<svg onload=alert(1)>')],
  ], url);
  assert.strictEqual(r.status, 200, (r.testo.match(/avviso errore">([^<]*)/) || [])[1]);
  assert.ok(!/<img src=x onerror/.test(r.testo), 'nome del file non deve finire nella pagina come HTML');
  assert.ok(!/<script>alert/.test(r.testo));
  const salvati = arrivi.inAttesa(id);
  for (const a of salvati) {
    assert.ok(!a.nome.includes('/') && !a.nome.includes('\\') && !a.nome.includes('\0'), a.nome);
    assert.match(a.nome, /\.pdf$/i);
    const abs = arrivi.percorso(a);
    assert.ok(abs.startsWith(path.join(process.env.DATI_DIR, 'arrivi')), abs);
  }
  assert.ok(salvati.length <= 3);
  // null byte nel nome: richiesta malformata, rifiutata senza salvare nulla
  const n0 = arrivi.inAttesa(id).length;
  assert.strictEqual((await b.carica(url, [['durc.pdf\u0000.exe', PDF]], url)).status, 400);
  assert.strictEqual(arrivi.inAttesa(id).length, n0);
  assert.ok(!fs.existsSync(path.join(process.env.DATI_DIR, 'studio.db.pdf')));
  // troppi file in un colpo
  const tanti = Array.from({ length: arrivi.LIMITI.filePerInvio + 2 }, (_, i) => [`f${i}.pdf`, PDF]);
  const r2 = await b.carica(url, tanti, url);
  assert.strictEqual(r2.status, 400);
  // campi in più / file con nome di campo diverso: ignorati, niente errore 500
  const fd = new FormData(); fd.append('_csrf', await b.csrf(url)); fd.append('altro', new Blob([PDF]), 'x.pdf');
  assert.notStrictEqual((await b.go(url, { method: 'POST', body: fd })).status, 500);
});

test('caricamento: file oltre 10 MB rifiutato senza riempire il disco; nessun file temporaneo resta', async () => {
  arrivi.azzeraInvii();
  const id = nuova();
  const url = arrivi.creaLink(id).replace(/^https?:\/\/[^/]+/, '');
  const grosso = Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024)]);
  const r = await browser().carica(url, [['grosso.pdf', grosso]], url);
  assert.strictEqual(r.status, 400);
  assert.match(r.testo, /10 MB/);
  await new Promise((ok) => setTimeout(ok, 200));
  const tmpDir = path.join(process.env.DATI_DIR, 'tmp');
  assert.deepStrictEqual(fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [], []);
});

test('caricamento: raffica di invii dallo stesso indirizzo viene fermata', async () => {
  arrivi.azzeraInvii();
  const id = nuova();
  const url = arrivi.creaLink(id).replace(/^https?:\/\/[^/]+/, '');
  const b = browser();
  let bloccato = false;
  for (let i = 0; i < 25 && !bloccato; i++) {
    const r = await b.carica(url, [[`d${i}.pdf`, PDF]], url);
    if (r.status === 429) bloccato = true;
  }
  assert.ok(bloccato, 'dopo 20 invii in un\'ora deve bloccare');
  assert.ok(arrivi.inAttesa(id).length <= 20);
  arrivi.azzeraInvii();
});

test('caricamento: non si possono accumulare più di 30 file in attesa per impresa', async () => {
  const id = nuova();
  const f = path.join(tmp, 'p.pdf'); fs.writeFileSync(f, PDF);
  let ultimo;
  for (let i = 0; i < 35; i++) ultimo = await arrivi.ricevi(id, { percorso: f, nome: `x${i}.pdf`, dimensione: PDF.length }, { origine: 'link' });
  assert.strictEqual(arrivi.inAttesa(id).length, arrivi.LIMITI.inAttesaPerImpresa);
  assert.strictEqual(ultimo.ok, false);
});

// ---------------- Documenti da controllare ----------------
test('arrivi: un\'impresa non vede né approva i file di un\'altra; clienti e anonimi fuori', async () => {
  const a = nuova(); const b = nuova();
  const f = path.join(tmp, 'q.pdf'); fs.writeFileSync(f, PDF);
  await arrivi.ricevi(a, { percorso: f, nome: 'segreto.pdf', dimensione: PDF.length }, { origine: 'link' });
  const [doc] = arrivi.inAttesa(a);
  // stesso file chiesto passando dall'altra impresa
  assert.strictEqual((await st.go(`/studio/imprese/${b}/arrivi/${doc.id}`)).status, 404);
  await st.post(`/studio/imprese/${b}/arrivi/${doc.id}`, { azione: 'scarta' }, `/studio/imprese/${b}`);
  assert.strictEqual(arrivi.inAttesa(a).length, 1);
  // cliente e anonimo
  assert.notStrictEqual((await cli.go(`/studio/imprese/${a}/arrivi/${doc.id}`)).status, 200);
  assert.notStrictEqual((await browser().go(`/studio/imprese/${a}/arrivi/${doc.id}`)).status, 200);
  // id non numerici o assurdi
  for (const x of ['abc', '-1', '1e9', '1;DROP TABLE imprese', '..%2F..%2Fstudio.db']) {
    const r = await st.go(`/studio/imprese/${a}/arrivi/${x}`);
    assert.ok([404, 400].includes(r.status), `${x} → ${r.status}`);
  }
  // approvazione con dati sporchi: tipo inventato, date finte, crediti assurdi
  await st.post(`/studio/imprese/${a}/arrivi/${doc.id}`, { azione: 'approva', tipo: '__proto__', rilascio: '2026-99-99', scadenza: "'; DROP TABLE imprese; --", crediti: '99999', numero: 'x'.repeat(5000) }, `/studio/imprese/${a}`);
  const reg = imprese.Q.documenti ? null : null; // eslint-disable-line no-unused-vars
  assert.ok(imprese.Q.perId.get(a), 'tabella imprese intatta');
  const altri = require('../src/db').prepare('SELECT * FROM documenti_impresa WHERE impresa_id = ?').all(a);
  assert.strictEqual(altri.length, 1);
  assert.strictEqual(altri[0].tipo, 'altro');
  assert.strictEqual(altri[0].scadenza, null);
  assert.strictEqual(altri[0].crediti, null);
  assert.ok(altri[0].numero.length <= 100);
  // doppia approvazione dello stesso file: la seconda non fa niente
  await st.post(`/studio/imprese/${a}/arrivi/${doc.id}`, { azione: 'approva', tipo: 'durc' }, `/studio/imprese/${a}`);
  assert.strictEqual(require('../src/db').prepare('SELECT COUNT(*) AS n FROM documenti_impresa WHERE impresa_id = ?').get(a).n, 1);
});

test('arrivi: senza CSRF non si approva né si scarta', async () => {
  const a = nuova();
  const f = path.join(tmp, 'r.pdf'); fs.writeFileSync(f, PDF);
  await arrivi.ricevi(a, { percorso: f, nome: 'r.pdf', dimensione: PDF.length }, { origine: 'link' });
  const [doc] = arrivi.inAttesa(a);
  const r = await st.go(`/studio/imprese/${a}/arrivi/${doc.id}`, { method: 'POST', body: new URLSearchParams({ azione: 'scarta' }) });
  assert.strictEqual(r.status, 403);
  const r2 = await st.go(`/studio/imprese/${a}/arrivi/${doc.id}`, { method: 'POST', body: new URLSearchParams({ azione: 'scarta', _csrf: 'falso' }) });
  assert.strictEqual(r2.status, 403);
  assert.strictEqual(arrivi.inAttesa(a).length, 1);
});

test('arrivi non controllati dall\'antivirus: solo download, mai mostrati nel browser', async () => {
  const a = nuova();
  const f = path.join(tmp, 's.pdf'); fs.writeFileSync(f, PDF);
  await arrivi.ricevi(a, { percorso: f, nome: 's.pdf', dimensione: PDF.length }, { origine: 'link' });
  const [doc] = arrivi.inAttesa(a);
  const r = await st.go(`/studio/imprese/${a}/arrivi/${doc.id}?scarica=0`);
  assert.match(r.headers.get('content-disposition') || '', /attachment/);
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
});

// ---------------- Risposte email ----------------
test('email: codice falsificato, codice di un\'altra impresa, mittente simile, mittente con nome ingannevole', async () => {
  const a = nuova({ email: 'ufficio@edile.it' });
  const b = nuova({ email: 'altro@edile.it' });
  const allegato = [['DURC.pdf', PDF, 'application/pdf']];
  const casi = [
    { da: 'ufficio@edile.it', oggetto: `Re: [Rif. IMP-${a}-000000]` }, // firma sbagliata
    { da: 'ufficio@edile.it', oggetto: `Re: ${arrivi.riferimento(b)}` }, // codice di B, mittente di A
    { da: 'ufficio@edile.it.truffa.com', oggetto: `Re: ${arrivi.riferimento(a)}` },
    { da: '"ufficio@edile.it" <truffa@altro.it>', oggetto: `Re: ${arrivi.riferimento(a)}` },
    { da: 'UFFICIO@edile.it.', oggetto: `Re: ${arrivi.riferimento(a)}` },
  ];
  for (const c of casi) {
    const r = await postaIn.elabora(await simpleParser(email({ ...c, allegati: allegato })));
    assert.notStrictEqual(r.esito, 'ricevuto', JSON.stringify(c));
  }
  assert.strictEqual(arrivi.inAttesa(a).length, 0);
  assert.strictEqual(arrivi.inAttesa(b).length, 0);
});

test('email: mittente falsificato rilevato dai controlli del provider (SPF/DMARC fail) viene scartato', async () => {
  const a = nuova({ email: 'ufficio@edile2.it' });
  const msg = email({ da: 'ufficio@edile2.it', oggetto: `Re: ${arrivi.riferimento(a)}`, allegati: [['DURC.pdf', PDF, 'application/pdf']],
    extraHeader: 'Authentication-Results: mx.aruba.it; spf=fail smtp.mailfrom=edile2.it; dmarc=fail header.from=edile2.it' });
  const r = await postaIn.elabora(await simpleParser(msg));
  assert.notStrictEqual(r.esito, 'ricevuto');
  assert.strictEqual(arrivi.inAttesa(a).length, 0);
});

test('email: allegati con nomi pericolosi, eseguibili, troppi allegati, PEC annidate a matrioska', async () => {
  const a = nuova({ email: 'mitt@edile3.it' });
  const rif = arrivi.riferimento(a);
  const r = await postaIn.elabora(await simpleParser(email({ da: 'mitt@edile3.it', oggetto: `Re: ${rif}`, allegati: [
    ['../../../etc/cron.d/x.pdf', PDF, 'application/pdf'],
    ['virus.exe', Buffer.from('MZ'), 'application/octet-stream'],
    ['doc.pdf.js', Buffer.from('alert(1)'), 'application/javascript'],
    ['falso.pdf', Buffer.from('MZ ma dice di essere pdf'), 'application/pdf'],
  ] })));
  assert.strictEqual(r.esito, 'ricevuto');
  assert.deepStrictEqual(r.salvati, ['x.pdf']);
  for (const x of arrivi.inAttesa(a)) assert.ok(arrivi.percorso(x).startsWith(path.join(process.env.DATI_DIR, 'arrivi')));
  // matrioska: eml dentro eml dentro eml (non deve andare in loop né esplodere)
  let interno = Buffer.from(email({ da: 'mitt@edile3.it', oggetto: `Re: ${rif}`, allegati: [['ok.pdf', PDF, 'application/pdf']] }));
  for (let i = 0; i < 20; i++) interno = Buffer.from(email({ da: 'mitt@edile3.it', oggetto: `Re: ${rif}`, allegati: [['postacert.eml', interno, 'message/rfc822']] }));
  const r2 = await postaIn.elabora(await simpleParser(interno));
  assert.ok(['ricevuto', 'senza-allegati', 'ignorato'].includes(r2.esito));
});

// ---------------- Promemoria e WhatsApp ----------------
test('promemoria e WhatsApp: cliente, anonimo e richieste senza CSRF non inviano niente; numeri ostili non diventano link', async () => {
  const id = nuova({ email: 'p@edile.it', telefono: '333 9999999' });
  const prima = fs.existsSync(process.env.POSTA_CARTELLA) ? fs.readdirSync(process.env.POSTA_CARTELLA).length : 0;
  for (const u of [cli, browser()]) {
    const c = await u.csrf('/accedi');
    for (const p of ['promemoria', 'promemoria-whatsapp']) {
      const r = await u.go(`/studio/imprese/${id}/${p}`, { method: 'POST', body: new URLSearchParams({ _csrf: c }) });
      assert.ok(!/wa\.me\/39333/.test((r.loc || '') + r.testo), `${p} → ${r.status}`);
    }
  }
  const r = await st.go(`/studio/imprese/${id}/promemoria-whatsapp`, { method: 'POST', body: new URLSearchParams({}) });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(fs.existsSync(process.env.POSTA_CARTELLA) ? fs.readdirSync(process.env.POSTA_CARTELLA).length : 0, prima);
  const t = require('../src/telefono');
  for (const x of ['javascript:alert(1)', '"><script>', '+39 333 1234567\nBcc: x@y.z', '1'.repeat(40), 'tel:+39333']) {
    assert.ok(!/javascript|script|Bcc|\n/i.test(t.tel(x) + t.whatsapp(x, 'a')), x);
  }
  // tipo inventato nel promemoria: viene trattato come «tutti», niente errore
  const r3 = await st.post(`/studio/imprese/${id}/promemoria`, { tipo: 'constructor' }, `/studio/imprese/${id}`);
  assert.strictEqual(r3.status, 302);
});

test('telefono di un cliente con nome ostile: niente HTML iniettato nei pulsanti WhatsApp', async () => {
  fs.mkdirSync(path.join(process.env.ARCHIVIO_DIR, 'W-1 Wa'), { recursive: true });
  const id = Number(Lavori.inserisci.run({ codice: 'W-1', titolo: '"><img src=x onerror=alert(1)>', descrizione: null, indirizzo: null, stato: 'In corso', cartella: 'W-1 Wa', data_inizio: null, data_fine: null, visibile: 1 }).lastInsertRowid);
  Lavori.aggiungiConRuolo.run(id, clienteId, 'proprietario', null);
  for (const [u, p] of [[st, `/studio/lavori/${id}`], [st, `/studio/clienti/${clienteId}`], [st, '/studio/clienti'], [cli, `/area/lavori/${id}`], [cli, '/area']]) {
    const t = (await u.go(p)).testo;
    assert.ok(!/<script>alert\(1\)/.test(t) && !/<img src=x onerror/.test(t), p);
  }
  const area = (await cli.go(`/area/lavori/${id}`)).testo;
  assert.match(area, /https:\/\/wa\.me\/393398561221\?text=/);
});

// ---------------- Modulo clienti del lavoro ----------------
test('modulo lavoro: non si collega l\'amministratore, un id inesistente o un ruolo inventato', async () => {
  fs.mkdirSync(path.join(process.env.ARCHIVIO_DIR, 'K-1 K'), { recursive: true });
  const id = Number(Lavori.inserisci.run({ codice: 'K-1', titolo: 'K', descrizione: null, indirizzo: null, stato: 'In corso', cartella: 'K-1 K', data_inizio: null, data_fine: null, visibile: 1 }).lastInsertRowid);
  const base0 = { codice: 'K-1', titolo: 'K', stato: 'In corso', cartella: 'K-1 K', visibile: '1' };
  for (const extra of [{ aggiungi_cliente: String(adminId), aggiungi_ruolo: 'proprietario' }, { aggiungi_cliente: '999999' }, { [`ruolo_${adminId}`]: 'proprietario' }, { aggiungi_cliente: '-1' }, { aggiungi_cliente: '1 OR 1=1' }]) {
    const r = await st.post(`/studio/lavori/${id}`, { ...base0, ...extra }, `/studio/lavori/${id}/modifica`);
    assert.ok(r.status < 500, JSON.stringify(extra));
  }
  assert.deepStrictEqual(Lavori.clienti.all(id), []);
  await st.post(`/studio/lavori/${id}`, { ...base0, aggiungi_cliente: String(clienteId), aggiungi_ruolo: 'admin' }, `/studio/lavori/${id}/modifica`);
  assert.deepStrictEqual(Lavori.clienti.all(id).map((c) => c.ruolo), ['proprietario']);
  // il cliente non può modificare il lavoro
  const c = await cli.csrf('/area');
  await cli.go(`/studio/lavori/${id}`, { method: 'POST', body: new URLSearchParams({ ...base0, titolo: 'Rubato', _csrf: c }) });
  assert.strictEqual(Lavori.perId.get(id).titolo, 'K');
});

// ---------------- Contabilità e riepilogo ----------------
test('contabilità: cliente e anonimo non vedono né eliminano notule; il riepilogo non è esposto fuori dallo studio', async () => {
  const n = contabilita.crea({ lavoro_id: null, dest_nome: 'Z', dest_indirizzo: '', dest_cf: '', dest_email: 'z@esempio.it', oggetto: '', data: '2026-11-16',
    voci: JSON.stringify([{ d: 'a', c: 100 }]), spese: '[]', cassa_pct: 5, iva_pct: 22, sostituto: 0, note: '' });
  contabilita.Q.segnaInviata.run(n);
  for (const u of [cli, browser()]) {
    assert.notStrictEqual((await u.go('/studio/contabilita')).status, 200);
    assert.notStrictEqual((await u.go(`/studio/contabilita/${n}/notula.pdf`)).status, 200);
    const c = await u.csrf('/accedi');
    await u.go(`/studio/contabilita/${n}/elimina`, { method: 'POST', body: new URLSearchParams({ _csrf: c }) });
    assert.ok(contabilita.Q.perId.get(n));
    assert.ok(!/Notule da incassare/.test((await u.go('/area')).testo));
  }
  assert.match((await st.go('/studio')).testo, /Notule da incassare/);
});
