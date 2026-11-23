# Studio Tecnico Geom. Niccolò Innocenti: sito e area clienti

L'app ha tre parti:

1. **Sito di presentazione** dello studio: servizi, chi siamo, contatti.
2. **Area clienti**: ogni cliente accede con email e password e vede i propri lavori. Per ogni lavoro trova i documenti divisi per categoria (Progetti, Computi, Contratti, Pratiche, Foto cantiere), lo stato e il diario degli aggiornamenti.
3. **Pannello dello studio** (`/studio`): qui crei clienti e lavori, carichi documenti, pubblichi aggiornamenti e vedi quando il cliente ha aperto un file.
4. **Cruscotto pratiche** (`/studio`, solo per lo studio): pratiche edilizie e catastali con scadenze, attività da fare, onorari e incassi, più email e messaggi WhatsApp scritti con l'AI.

I file **restano sul NAS QNAP**, nelle normali cartelle condivise. L'app non li copia altrove: legge direttamente la cartella del lavoro. Puoi quindi continuare a salvare i file dal PC dello studio (rete/SMB) e il cliente li vede subito.

## Cruscotto pratiche

Ogni **lavoro** può avere più **pratiche** (es. "Ristrutturazione Rossi" → SCIA + DOCFA + APE). Le pratiche **non sono mai visibili ai clienti**.

- **Cruscotto** (`/studio`): scadenze superate (in rosso) e dei prossimi 30 giorni, attività da fare, pratiche aperte ordinate per scadenza, totale da incassare e incassato dell'anno. Le scadenze e le attività si spuntano direttamente da qui.
- **Scheda pratica**: tipo, Comune/ente, oggetto, stato, n. e data di protocollo, n. pratica dell'ente, note interne. Ci sono poi:
  - **Scadenze**: con suggerimenti (integrazioni, inizio/fine lavori, agibilità…);
  - **Attività da fare**: una lista con le spunte;
  - **Onorario e incassi**: registri acconti e saldi, il residuo si calcola da solo;
  - **Email e WhatsApp**: scegli il destinatario (i clienti del lavoro sono già proposti), scrivi due righe su cosa dire e premi **✨ Scrivi con AI**. Claude prepara la bozza con i dati della pratica e lascia tra `[parentesi quadre]` quello che non sa. La rileggi, la correggi e premi **Apri email** / **Apri in WhatsApp**: si apre il programma di posta o WhatsApp con il messaggio già pronto, e l'invio finale lo fai tu. Ogni messaggio resta nello storico della pratica.
- Tipi di pratica, stati, enti (Comuni del Valdarno, Agenzia Entrate, Genio Civile…) e scadenze tipiche sono in `config/studio.json` → `pratiche`. Puoi modificarli; nei campi puoi comunque scrivere valori liberi.

### Attivare l'assistente AI

1. Crea una chiave API su [platform.claude.com](https://platform.claude.com) (sezione API keys) e imposta un limite di spesa mensile. Ogni bozza costa una frazione di centesimo.
2. Nel `.env` del NAS scrivi `ANTHROPIC_API_KEY=la-tua-chiave` e riavvia: `docker compose up -d`.
3. Il NAS deve poter uscire su Internet verso `api.anthropic.com`.

Al servizio AI vengono inviati solo i dati della pratica (tipo, ente, protocollo, scadenze, attività, importi) e il nome del destinatario. I documenti del NAS non vengono mai inviati. Senza chiave tutto il resto funziona e i messaggi si scrivono a mano.

## Come sono organizzati i file sul NAS

```
/share/Lavori/                       ← cartella "archivio" (ARCHIVIO_NAS)
└── 2026-001 Rossi Ristrutturazione/ ← cartella del lavoro
    ├── Progetti/                    ← visibile al cliente
    │   ├── Tavola 01 - Pianta.pdf
    │   └── Variante/Tavola 01b.pdf  ← anche le sottocartelle sono visibili
    ├── Computi/                     ← visibile al cliente
    ├── Contratti/                   ← visibile al cliente
    ├── Pratiche/                    ← visibile al cliente
    ├── Foto/                        ← visibile al cliente
    └── Interno/                     ← NON visibile (qualsiasi altra cartella è privata)
```

Regole:

- Il cliente vede **solo** le sottocartelle elencate in `config/studio.json` → `categorie`. Tutto il resto (parcelle, corrispondenza, appunti…) resta privato.
- I file e le cartelle che iniziano con `_` o `.` sono **sempre nascosti** (es. `_bozza computo.xlsx`). È comodo per tenere le bozze nella stessa cartella.
- Quando crei un lavoro, l'app crea da sola la cartella e le sottocartelle. Puoi anche collegare una cartella già esistente, ad esempio `2025/2025-018 Bianchi`.
- Se elimini un lavoro dall'app, **i file sul NAS non vengono toccati**.

## Installazione sul QNAP

Requisiti: **Container Station** installato dall'App Center.

1. **Crea le cartelle condivise** (Pannello di controllo → Cartelle condivise):
   - `Lavori`: l'archivio dei lavori (oppure usa la cartella che hai già).
   - `Container/studio-tecnico`: database e dati interni dell'app.
2. **Copia il progetto sul NAS**, ad esempio in `/share/Container/studio-tecnico-app`. Puoi clonarlo con git via SSH oppure copiare la cartella dal PC.
3. **Crea il file `.env`** partendo da `.env.example`:
   ```sh
   cp .env.example .env
   openssl rand -hex 32   # incolla il risultato in SESSION_SECRET
   ```
   Imposta `ARCHIVIO_NAS` sul percorso reale della cartella lavori.
4. **Avvia** con Container Station (Applicazioni → Crea → incolla il `docker-compose.yml`) oppure via SSH:
   ```sh
   cd /share/Container/studio-tecnico-app
   docker compose up -d --build
   ```
5. **Crea il tuo account da amministratore**:
   ```sh
   docker exec -it studio-tecnico node --disable-warning=ExperimentalWarning scripts/crea-admin.js tua@email.it "Niccolò Innocenti"
   ```
6. Apri `http://IP-DEL-NAS:3000`, accedi e vai su **Clienti → Nuovo cliente**. L'app genera una password temporanea da comunicare al cliente, che potrà cambiarla dal suo profilo.

### Permessi

L'app scrive nella cartella lavori (upload e creazione delle cartelle) con l'utente indicato in `PUID`/`PGID`. Per conoscere i valori del tuo utente QNAP, via SSH:

```sh
id nomeutente     # es. uid=1000(niccolo) gid=100(everyone)
```

Usa quei valori nel `.env`: così i file caricati dall'app restano modificabili anche dal PC.

## Accesso dai clienti via Internet (HTTPS)

I clienti devono raggiungere l'app da fuori: **usa sempre HTTPS** e non esporre direttamente su Internet l'interfaccia di amministrazione del QNAP. Hai due strade.

**A. Cloudflare Tunnel (consigliata).** Non apre nessuna porta sul router.
1. Registra un dominio (es. `studioinnocenti.it`) e gestiscilo con Cloudflare (piano gratuito).
2. Avvia sul QNAP il container `cloudflare/cloudflared` con il token del tunnel e punta `area.tuodominio.it` → `http://studio-tecnico:3000`.
3. Nel `.env` imposta `COOKIE_SECURE=true` e `TRUST_PROXY=true`.

**B. Reverse proxy del QNAP + Let's Encrypt.**
1. In QTS: Pannello di controllo → Applicazioni → Server web → **Proxy inverso**: crea una regola `HTTPS 443 → localhost:3000`.
2. Installa il certificato Let's Encrypt (Pannello di controllo → Sicurezza → Certificato) per il tuo dominio o per l'indirizzo myQNAPcloud.
3. Sul router inoltra **solo** la porta 443 al NAS.
4. Nel `.env` imposta `COOKIE_SECURE=true` e `TRUST_PROXY=true`.

In entrambi i casi tieni QTS e Container Station aggiornati e attiva la verifica in due passaggi sull'account admin del NAS.

## Backup

Includi nei backup del NAS (Hybrid Backup Sync):
- la cartella lavori (`ARCHIVIO_NAS`);
- la cartella dati (`DATI_NAS`), che contiene `studio.sqlite` con clienti, lavori, pratiche, scadenze, incassi, aggiornamenti e log degli accessi.

## Personalizzazione

Tutti i testi dello studio sono in **`config/studio.json`**: nome, indirizzo, telefono, email, PEC, P.IVA, iscrizione all'albo, servizi, categorie di documenti e stati dei lavori. Il campo `email` è facoltativo: se lo lasci vuoto, il sito mostra solo cellulare e PEC. Dopo ogni modifica riavvia il container (`docker compose restart`).

Il logo è in `public/img/logo.webp`. Esiste anche una versione vettoriale, `public/img/logo.svg`, usata per l'icona del browser e la home.

## Sviluppo in locale

```sh
npm install
ADMIN_PASSWORD=unapasswordlunga npm run crea-admin -- studio@esempio.it "Niccolò Innocenti"
npm run dev        # http://localhost:3000
npm test
```

Senza variabili d'ambiente, i dati vanno in `./dati/` (ignorata da git).

## Sicurezza (in breve)

- Password salvate con bcrypt; massimo 8 tentativi di login ogni 15 minuti.
- Sessioni salvate su SQLite, cookie `httpOnly`/`SameSite`, token CSRF su tutti i moduli.
- Ogni cliente vede solo i lavori a cui è associato. I percorsi dei file sono controllati per impedire l'uscita dalla cartella della categoria (anche tramite `../` o link simbolici).
- Se disattivi un cliente o gli reimposti la password, le sue sessioni aperte vengono chiuse subito.

## Struttura del codice

```
src/server.js          avvio Express e configurazione
src/archivio.js        lettura/scrittura delle cartelle sul NAS (con controlli sui percorsi)
src/auth.js            login, permessi, CSRF, limite tentativi
src/routes/pubblico.js sito pubblico e login
src/routes/area.js     area clienti
src/routes/studio.js   pannello dello studio (lavori, clienti, documenti)
src/routes/pratiche.js cruscotto, pratiche, scadenze, incassi, messaggi
src/ai.js              bozze di email/WhatsApp con Claude
src/formato.js         importi, date, link WhatsApp/email
views/                 pagine (EJS)
public/                CSS, JS, logo
config/studio.json     dati e testi dello studio
```
