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

Tipi di pratica, stati, enti (Comuni del Valdarno, Agenzia Entrate, Genio Civile…) e scadenze tipiche sono in `config/studio.json`. Puoi modificarli; nei campi puoi comunque scrivere valori liberi.

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

1. Crea una chiave su [platform.claude.com](https://platform.claude.com) (sezione *API keys*) e imposta un limite di spesa mensile. Ogni bozza costa una frazione di centesimo.
2. Apri il file `.env` nella cartella del cruscotto (si crea al primo avvio; si apre con il Blocco note) e scrivi `ANTHROPIC_API_KEY=la-tua-chiave`.
3. Chiudi e riapri il cruscotto.

Al servizio AI vengono inviati solo i dati della pratica (tipo, ente, protocollo, scadenze, attività, importi) e il nome del destinatario. Senza chiave tutto il resto funziona e i messaggi si scrivono a mano.

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
src/routes/posta.js    sezione Posta
src/formato.js         importi, date, link WhatsApp/email
views/                 pagine (EJS)
config/studio.json     dati dello studio ed elenchi delle pratiche
```

In futuro, per collegarlo all'area clienti, il campo **commessa** delle pratiche corrisponde al codice dei lavori dell'area clienti.
