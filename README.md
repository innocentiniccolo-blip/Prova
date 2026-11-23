# Studio Tecnico Geom. Niccolò Innocenti: sito e area clienti

> Nella cartella [`cruscotto/`](cruscotto/README.md) c'è un programma separato, il **cruscotto pratiche**, che gira solo sul PC dell'ufficio. Questa pagina riguarda l'area clienti.

L'app ha tre parti:

1. **Sito di presentazione** dello studio: servizi, chi siamo, contatti.
2. **Area clienti**: ogni cliente accede con email e password e vede i propri lavori. Per ogni lavoro trova i documenti divisi per categoria (Progetti, Computi, Contratti, Pratiche, Foto cantiere), lo stato e il diario degli aggiornamenti.
3. **Pannello dello studio** (`/studio`): qui crei clienti e lavori, carichi documenti, pubblichi aggiornamenti e vedi quando il cliente ha aperto un file.

I file **restano sul NAS QNAP**, nelle normali cartelle condivise. L'app non li copia altrove: legge direttamente la cartella del lavoro. Puoi quindi continuare a salvare i file dal PC dello studio (rete/SMB) e il cliente li vede subito.

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
- la cartella dati (`DATI_NAS`), che contiene `studio.sqlite` con clienti, lavori, aggiornamenti e log degli accessi.

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
src/routes/studio.js   pannello dello studio
views/                 pagine (EJS)
public/                CSS, JS, logo
config/studio.json     dati e testi dello studio
```
