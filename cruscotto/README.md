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

Tipi di pratica, stati, enti (Comuni del Valdarno, Agenzia Entrate, Genio Civile…) e scadenze tipiche sono in `config/studio.json`. Puoi modificarli; nei campi puoi comunque scrivere valori liberi.

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
src/ai.js              bozze di email/WhatsApp con Claude
src/formato.js         importi, date, link WhatsApp/email
views/                 pagine (EJS)
config/studio.json     dati dello studio ed elenchi delle pratiche
```

In futuro, per collegarlo all'area clienti, il campo **commessa** delle pratiche corrisponde al codice dei lavori dell'area clienti.
