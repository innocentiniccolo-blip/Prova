# Cruscotto pratiche – Studio Tecnico Geom. Niccolò Innocenti

Programma per gestire le pratiche dello studio: scadenze, attività da fare, onorari e incassi, e messaggi email/WhatsApp scritti con l'AI.

**Funziona solo sul PC su cui è installato.** Si apre nel browser all'indirizzo `http://localhost:3100` e nessun altro dispositivo (telefoni, altri PC, internet) può collegarsi. È separato dall'area clienti: ha il suo archivio e la sua rubrica clienti.

## Installazione sul PC (una volta sola)

1. Installa **Node.js** da [nodejs.org](https://nodejs.org): scarica la versione **LTS** e segui l'installazione con le opzioni predefinite.
2. Copia la cartella `cruscotto` sul PC, ad esempio in `Documenti\Cruscotto`.
3. Fai doppio clic su **`avvia-cruscotto.bat`**. La prima volta scarica i componenti necessari (serve internet, un paio di minuti), poi apre il browser sul cruscotto.

Comodo: fai clic destro su `avvia-cruscotto.bat` → *Invia a* → *Desktop (crea collegamento)*.

## Uso quotidiano

- Avvia il cruscotto con il doppio clic su `avvia-cruscotto.bat` (o sul collegamento). Si apre una finestra nera: **lasciala aperta** finché usi il cruscotto. Per chiudere, chiudi quella finestra.
- Se il browser non si apre da solo, vai su `http://localhost:3100`.
- Su Mac si usa `avvia-cruscotto.command`.

## Cosa fa

- **Cruscotto**: scadenze superate (in rosso) e dei prossimi 30 giorni, attività da fare, pratiche aperte ordinate per scadenza, totale da incassare e incassato dell'anno. Le scadenze e le attività si spuntano direttamente da lì.
- **Pratiche**: cliente, codice commessa (es. 2026-014), indirizzo dell'immobile, tipo, Comune/ente, oggetto, stato, protocollo, n. pratica dell'ente, onorario, note interne. Il cliente si sceglie dalla rubrica o si crea al momento.
- **Scadenze**, **attività** e **incassi** per ogni pratica. Il residuo da incassare si calcola da solo.
- **Email e WhatsApp**: scrivi due righe su cosa dire e premi **✨ Scrivi con AI**. Claude prepara la bozza con i dati della pratica e lascia tra `[parentesi quadre]` quello che non sa. La rileggi e premi **Apri email** / **Apri in WhatsApp**: si apre il programma di posta o WhatsApp (Web o app) con il messaggio già pronto. L'invio finale lo fai tu. Ogni messaggio resta nello storico della pratica.
- **Clienti**: rubrica con cellulare ed email, e l'elenco delle pratiche di ciascuno.
- **Posta**: legge la casella dello studio, abbina le mail alle pratiche e prepara le risposte (vedi sotto).
- **Cartelle Google Drive**: ogni pratica collegata alla sua cartella in "Studio Innocenti" (vedi sotto).
- **WhatsApp**: le chat esportate ogni sera vengono importate, collegate ai clienti e riassunte, con la bozza di risposta (vedi sotto).

Tipi di pratica, stati, enti (Comuni del Valdarno, Agenzia Entrate, Genio Civile…) e scadenze tipiche sono in `config/studio.json`. Puoi modificarli; nei campi puoi comunque scrivere valori liberi.

## Cartelle su Google Drive

Ogni pratica può essere collegata alla sua cartella dentro **Studio Innocenti** su Google Drive (es. `Sofia Forzini`, oppure `Sofia Forzini/006-SCIA prot.10912`).

- Nel modulo della pratica scegli una cartella esistente o scrivi un nome nuovo: se non esiste, viene creata con le **sottocartelle standard** (001-Rilievo, 002-Computo, 003-Preventivi, 004-Istanza, 005-Nota Tecnica, 006-Pratiche, 007-Sicurezza, 008-Progetto, 009-Contabilità cantiere, 010-Fatture). L'elenco si cambia in `config/studio.json` → `sottocartelle`.
- Nella scheda della pratica vedi i file della cartella. **Apri cartella** apre Esplora risorse; un clic su un file lo apre con il suo programma (PDF, AutoCAD, Excel…). Puoi anche caricare file in una sottocartella.
- Tutto passa da **Google Drive per desktop**: quello che fai qui compare su Drive (e al collaboratore con cui condividi le cartelle) e viceversa.

**Installazione:** installa [Google Drive per desktop](https://www.google.com/drive/download/) e accedi con l'account dello studio. Il cruscotto trova da solo la cartella (di solito `G:\Il mio Drive\Studio Innocenti`); nella finestra nera compare "Google Drive: …". Se non la trova, scrivi il percorso nel `.env`: `DRIVE_DIR=G:\Il mio Drive\Studio Innocenti`.

## WhatsApp: chat importate ogni sera

WhatsApp non permette ai programmi di leggere le chat in automatico (e il backup di WhatsApp su Drive è cifrato). Il passaggio è semplice:

1. **Ogni sera** (alle 18:30 ti arriva il promemoria sul telefono) esporti le chat della giornata con i clienti: in WhatsApp apri la chat → ⋮ → *Altro* → **Esporta chat** → **Senza media** → **Drive** → cartella **Studio Innocenti / _WhatsApp da importare**. Su iPhone: tocca il nome del contatto → *Esporta chat*.
2. Il cruscotto controlla la cartella ogni 10 minuti (o premi **Importa ora** nella sezione WhatsApp):
   - collega ogni chat al **cliente** (dal nome salvato in rubrica, anche invertito tipo "Rossi Mario", o dal numero di telefono). Se non lo trova, la chat compare "da collegare": scegli il cliente una volta e il collegamento resta per le esportazioni successive;
   - salva **solo i messaggi nuovi**: puoi esportare ogni volta la chat intera, senza doppioni;
   - sposta il file in `_WhatsApp da importare/Importate/data`;
   - se l'ultimo messaggio è del cliente, la chat va tra quelle **da rispondere** e l'AI prepara un **riassunto** e la **bozza di risposta** (che tiene conto delle pratiche del cliente).
3. Rileggi la bozza e premi **Apri in WhatsApp**: si apre WhatsApp con il messaggio pronto, lo invii tu.

Le chat compaiono anche nel cruscotto e nella scheda del cliente. Vale lo stesso discorso privacy della posta: i messaggi vengono inviati all'AI per riassunto e bozza (con `EMAIL_BOZZE_AUTOMATICHE=no` solo quando la chiedi).

## Posta: lettura automatica e risposte preparate

Il cruscotto si collega alla casella dello studio (Aruba) e ogni 5 minuti, mentre è aperto:

1. **legge le mail nuove** della posta in arrivo, **senza segnarle come lette**: in Thunderbird le vedi come sempre;
2. **le abbina alla pratica**: dal mittente, se è un cliente in rubrica, oppure dal protocollo, dal n. pratica dell'ente o dalla commessa scritti nell'oggetto o nel testo. Così anche la PEC inoltrata o la mail dell'ufficio tecnico che cita il protocollo finisce nella pratica giusta;
3. **prepara la bozza di risposta** con l'AI, usando i dati della pratica, per le mail dei clienti e quelle legate a una pratica. Per le altre la bozza si chiede con un clic.

Nella sezione **Posta** (e nel cruscotto) trovi le mail da rispondere. Apri la mail, rileggi la bozza (se vuoi la fai riscrivere con due righe di indicazioni), poi scegli:

- **Invia**: parte da info@…, la copia va nella cartella *Inviata* e la mail originale risulta "risposta" anche in Thunderbird. Se la mail è legata a una pratica, la risposta finisce nel suo storico;
- **Salva nelle Bozze di Thunderbird**: la ritrovi nelle *Bozze* di Thunderbird e la spedisci da lì;
- **Archivia** se non serve rispondere.

**Niente parte mai da solo:** ogni risposta la approvi tu.

### Collegare la casella Aruba

Nel file `.env`:

```
EMAIL_INDIRIZZO=info@geometrainnocenti.it
EMAIL_PASSWORD=la-password-della-casella
```

I server di Aruba (`imaps.aruba.it` porta 993, `smtps.aruba.it` porta 465) sono già impostati. Chiudi e riapri il cruscotto: nella finestra nera compare "Posta: info@…, controllo ogni 5 minuti".

**Controlla Thunderbird:** apri *Impostazioni account* → *Impostazioni server*. Se il tipo di server è **IMAP**, va tutto bene. Se è **POP3**, deve essere spuntato **"Lascia i messaggi sul server"**, altrimenti Thunderbird scarica e cancella le mail prima che il cruscotto le veda (e le bozze salvate sul server non comparirebbero in Thunderbird). Il consiglio è passare a IMAP.

Note:
- La password resta nel file `.env` di questo PC: non condividere quel file.
- Il testo delle mail viene inviato al servizio AI per preparare le bozze (non viene usato per addestrare i modelli). Conviene citarlo nell'informativa privacy dello studio. Con `EMAIL_BOZZE_AUTOMATICHE=no` le bozze si preparano solo quando le chiedi.
- Le mail vengono mostrate come testo semplice: niente immagini o contenuti esterni.

## Assistente AI (facoltativo)

Il cruscotto può usare **Google Gemini** oppure **Claude** (Anthropic). Basta una delle due chiavi nel file `.env`; nella finestra nera all'avvio compare quale servizio è attivo ("Assistente AI: Google Gemini…").

**Gemini (piano gratuito):**
1. Vai su [aistudio.google.com](https://aistudio.google.com), accedi con il tuo account Google e premi **Get API key** → **Crea chiave API**.
2. Apri il file `.env` nella cartella del cruscotto (con il Blocco note) e scrivi `GEMINI_API_KEY=la-tua-chiave` (inizia con `AIza…`).
3. Chiudi e riapri il cruscotto.

Il piano gratuito ha un limite di richieste al minuto e al giorno: se lo raggiungi compare "Limite gratuito di Gemini raggiunto", basta riprovare più tardi. **Privacy:** con il piano gratuito Google può usare i testi inviati per migliorare i suoi servizi. Per gli utenti europei dovrebbe valere un'eccezione (stesso trattamento del piano a pagamento), ma va verificata nelle condizioni attuali (ai.google.dev/gemini-api/terms, sezione "How Google Uses Your Data"). Mail e chat dei clienti contengono dati personali: tienine conto nell'informativa privacy dello studio, oppure attiva la fatturazione su Google AI Studio o usa Claude.

**Claude (a pagamento):** crea la chiave su [platform.claude.com](https://platform.claude.com) (sezione *API keys*), imposta un limite di spesa mensile e scrivi `ANTHROPIC_API_KEY=la-tua-chiave` nel `.env`. Con le API di Anthropic i dati non vengono usati per addestrare i modelli.

Se nel `.env` ci sono entrambe le chiavi, il cruscotto usa Claude; per usare Gemini aggiungi `AI_FORNITORE=gemini`.

All'AI vengono inviati solo i dati della pratica (tipo, ente, protocollo, scadenze, attività, importi), il nome del destinatario e, per posta e WhatsApp, il testo dei messaggi da rispondere. I documenti delle cartelle non vengono mai inviati.

## Backup

Tutto l'archivio è in un solo file: `dati\cruscotto.sqlite`. **Copialo regolarmente** (sul NAS, su una chiavetta o nel cloud). Con il cruscotto chiuso copia anche gli eventuali file `cruscotto.sqlite-wal` e `cruscotto.sqlite-shm`.

Per salvare l'archivio direttamente in un'altra cartella (es. una cartella sincronizzata con il cloud), nel file `.env` imposta `DATI_DIR=C:\percorso\della\cartella`.

## Sicurezza

- Il programma ascolta solo su `127.0.0.1` (il PC stesso): dalla rete non è raggiungibile.
- Rifiuta le richieste che non usano l'indirizzo `localhost`: così un sito web aperto nel browser non può interrogarlo.
- Ogni modulo ha un token di sicurezza contro le richieste falsificate.

## Per lo sviluppo

```sh
npm install
npm run dev     # http://localhost:3100
npm test
```

```
src/server.js          avvio e configurazione
src/sicurezza.js       accesso solo locale e token dei moduli
src/routes/pratiche.js cruscotto, pratiche, scadenze, incassi, messaggi
src/routes/clienti.js  rubrica clienti
src/ai.js              bozze di email/WhatsApp e risposte alle mail con Claude
src/posta.js           collegamento IMAP/SMTP alla casella (Aruba)
src/sincronizza.js     controllo periodico della posta e bozze automatiche
src/abbina.js          abbinamento mail → cliente/pratica
src/cartelle.js        cartelle delle pratiche su Google Drive
src/whatsapp.js        importazione delle chat dalla cartella di Drive
src/whatsapp-lettore.js lettura dei file esportati da WhatsApp
src/routes/posta.js    sezione Posta
src/formato.js         importi, date, link WhatsApp/email
views/                 pagine (EJS)
config/studio.json     dati dello studio ed elenchi delle pratiche
```

In futuro, per collegarlo all'area clienti, il campo **commessa** delle pratiche corrisponde al codice dei lavori dell'area clienti.
