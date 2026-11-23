'use strict';
/**
 * Bozze di messaggi (email / WhatsApp) scritte da Claude a partire dai dati della pratica.
 * Il testo NON viene mai inviato in automatico: torna nel modulo, il geometra lo rilegge e decide.
 */
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const { euro, oggi } = require('./formato');

const MODELLO = process.env.AI_MODELLO || 'claude-opus-5-5';
let client = null;

const attiva = () => Boolean(process.env.ANTHROPIC_API_KEY);

function getClient() {
  if (!client) client = new Anthropic({ timeout: 90_000, maxRetries: 2 });
  return client;
}

const SCHEMA = {
  type: 'object',
  properties: {
    oggetto: { type: 'string', description: "Oggetto dell'email. Stringa vuota per WhatsApp." },
    testo: { type: 'string', description: 'Testo completo del messaggio, pronto da inviare.' },
  },
  required: ['oggetto', 'testo'],
  additionalProperties: false,
};

function istruzioniSistema() {
  const s = config.studio;
  const contatti = [s.telefono && `Cell. ${s.telefono}`, s.email && `Email ${s.email}`, s.pec && `PEC ${s.pec}`].filter(Boolean).join(' – ');
  return `Scrivi messaggi per conto di ${s.nome}, studio tecnico di un geometra nel Valdarno aretino (${s.indirizzo}).
I destinatari sono clienti privati, imprese, colleghi tecnici o uffici pubblici (Comuni, Agenzia delle Entrate – Territorio, Genio Civile).

Regole:
- Scrivi in italiano corretto, con tono professionale e cordiale. Dai del Lei ai clienti, salvo che le istruzioni dicano di dare del tu. Con gli uffici pubblici usa un registro formale.
- Usa solo i dati forniti nella scheda della pratica. Non inventare numeri di protocollo, importi, date, nomi o riferimenti normativi che non compaiono. Se manca un dato che serve, lascia un segnaposto tra parentesi quadre, ad esempio [data del sopralluogo], così il geometra lo completa.
- Riporta gli importi in euro come compaiono nella scheda. Accenna a pagamenti o somme da saldare solo se le istruzioni lo chiedono.
- Email: oggetto breve e specifico (es. "SCIA via Roma 12 – richiesta documenti"). Il testo inizia con un saluto e finisce con una firma che contiene: ${s.nomeBreve}${contatti ? `, ${contatti}` : ''}.
- WhatsApp: oggetto vuoto. Messaggio breve (al massimo 5-6 righe), diretto, niente formule burocratiche, chiuso dal solo nome "${s.nomeBreve}". Niente markdown, al massimo un elenco puntato semplice se servono più documenti.
- Non usare markdown nelle email (niente asterischi o titoli): il testo va incollato così com'è nel programma di posta.`;
}

/** Testo con i dati della pratica che Claude usa come contesto. */
function schedaPratica({ pratica, scadenze = [], attivita = [], destinatario, canale }) {
  const righe = [
    `Data di oggi: ${oggi()}`,
    `Canale: ${canale === 'whatsapp' ? 'WhatsApp' : 'Email'}`,
    `Destinatario: ${destinatario || 'non indicato'}`,
    '',
    pratica.commessa && `Commessa dello studio: ${pratica.commessa}`,
    pratica.indirizzo && `Immobile: ${pratica.indirizzo}`,
    pratica.cliente_nome && `Cliente: ${pratica.cliente_nome}`,
    `Pratica: ${pratica.tipo}${pratica.ente ? ` presso ${pratica.ente}` : ''}`,
    pratica.oggetto && `Oggetto della pratica: ${pratica.oggetto}`,
    `Stato: ${pratica.stato}`,
    pratica.protocollo && `Protocollo: n. ${pratica.protocollo}${pratica.data_protocollo ? ` del ${pratica.data_protocollo}` : ''}`,
    pratica.numero_pratica && `Numero pratica dell'ente: ${pratica.numero_pratica}`,
    pratica.onorario_cent > 0 && `Onorario concordato: ${euro(pratica.onorario_cent)} – già incassato: ${euro(pratica.incassato_cent)} – da saldare: ${euro(Math.max(pratica.onorario_cent - pratica.incassato_cent, 0))}`,
  ];
  const aperte = scadenze.filter((s) => !s.fatta);
  if (aperte.length) righe.push('', 'Scadenze aperte:', ...aperte.map((s) => `- ${s.data}: ${s.descrizione}`));
  const daFare = attivita.filter((a) => !a.fatta);
  if (daFare.length) righe.push('', 'Attività ancora da fare:', ...daFare.map((a) => `- ${a.testo}`));
  return righe.filter((r) => r !== false && r != null).join('\n');
}

class ErroreAI extends Error {}

/**
 * Genera la bozza. Ritorna { oggetto, testo }.
 * @param {object} p  { pratica, scadenze, attivita, destinatario, canale, istruzioni }
 */
async function generaMessaggio(p) {
  if (!attiva()) throw new ErroreAI("L'assistente AI non è configurato: aggiungi ANTHROPIC_API_KEY nel file .env e riavvia.");
  const richiesta = `<scheda_pratica>\n${schedaPratica(p)}\n</scheda_pratica>\n\n` +
    `Cosa deve dire il messaggio (istruzioni del geometra):\n${p.istruzioni || 'Aggiorna il destinatario sullo stato della pratica.'}`;

  let risposta;
  try {
    risposta = await getClient().beta.messages.create({
      model: MODELLO,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: istruzioniSistema(),
      messages: [{ role: 'user', content: richiesta }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new ErroreAI('Chiave ANTHROPIC_API_KEY non valida.');
    if (e instanceof Anthropic.RateLimitError) throw new ErroreAI('Troppe richieste all\'AI: riprova tra qualche secondo.');
    if (e instanceof Anthropic.APIConnectionError) throw new ErroreAI('Impossibile contattare il servizio AI: controlla la connessione del NAS.');
    if (e instanceof Anthropic.APIError) throw new ErroreAI(`Errore del servizio AI (${e.status ?? 'sconosciuto'}).`);
    throw e;
  }

  if (risposta.stop_reason === 'refusal') throw new ErroreAI("L'AI non ha scritto questo messaggio: riformula le istruzioni.");
  if (risposta.stop_reason === 'max_tokens') throw new ErroreAI('Messaggio troppo lungo: chiedi un testo più breve.');
  const blocco = risposta.content.find((b) => b.type === 'text');
  let dati;
  try { dati = JSON.parse(blocco?.text || ''); } catch { throw new ErroreAI("Risposta dell'AI non leggibile: riprova."); }
  return {
    oggetto: p.canale === 'whatsapp' ? '' : String(dati.oggetto || '').trim(),
    testo: String(dati.testo || '').trim(),
  };
}

module.exports = { attiva, generaMessaggio, schedaPratica, ErroreAI, MODELLO };
