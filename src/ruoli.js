'use strict';
/**
 * Ruoli di chi è collegato a un lavoro. Ogni ruolo vede solo le pratiche spuntate per lui:
 *  - proprietario (o committente): ciò che lo studio rende visibile, come sempre;
 *  - agenzia immobiliare: solo le pratiche per la compravendita, e solo con il consenso del proprietario;
 *  - impresa: solo il cantiere (sicurezza e pratiche spuntate).
 */
const RUOLI = {
  proprietario: { nome: 'Proprietario / committente', colonna: 'visibile', sicurezza: true, aggiornamenti: true },
  agenzia: { nome: 'Agenzia immobiliare', colonna: 'visibile_agenzia', sicurezza: false, aggiornamenti: false },
  impresa: { nome: 'Impresa', colonna: 'visibile_impresa', sicurezza: true, aggiornamenti: false },
};
const ruoloValido = (r) => (RUOLI[r] ? r : 'proprietario');

/** La pratica come la vede un ruolo: "visibile" diventa la visibilità di quel ruolo. */
function perRuolo(pratica, ruolo) {
  if (!pratica) return pratica;
  return { ...pratica, visibile: Number(pratica[RUOLI[ruoloValido(ruolo)].colonna]) ? 1 : 0 };
}

// Pratiche che di solito servono a un'agenzia per vendere: proposte come consigliate
const PER_AGENZIA = /accesso\s*atti|conformit|\bape\b|attestat\w*\s+(di\s+)?prestazione|sanatori|regolarizz|catast|docfa|accertamento|cila\s+tardiva|agibilit|planimetri|visur/i;
const consigliataAgenzia = (nome) => PER_AGENZIA.test(String(nome || ''));

module.exports = { RUOLI, ruoloValido, perRuolo, consigliataAgenzia };
