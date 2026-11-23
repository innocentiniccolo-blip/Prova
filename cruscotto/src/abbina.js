'use strict';
/**
 * Abbina una mail ricevuta a un cliente e, se possibile, a una pratica.
 * Regole (in ordine):
 *  1. il mittente è un cliente della rubrica → cliente;
 *  2. nell'oggetto o nel testo compare il protocollo, il n. pratica dell'ente o la commessa di una pratica aperta
 *     → quella pratica (a parità, si preferiscono le pratiche del cliente mittente);
 *  3. il cliente mittente ha una sola pratica aperta → quella pratica.
 * Altrimenti la pratica resta da scegliere a mano.
 */

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Codici utili di una pratica: troppo corti o generici darebbero falsi abbinamenti. */
function codiciPratica(p) {
  return [p.protocollo, p.numero_pratica, p.commessa]
    .map((c) => String(c || '').trim())
    .filter((c) => (/^\d+$/.test(c) ? c.length >= 4 : c.length >= 3));
}

function contieneCodice(testo, codice) {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escape(codice)}($|[^\\p{L}\\p{N}])`, 'iu').test(testo);
}

/**
 * @param {{mittente: string, oggetto: string, testo: string}} mail
 * @param {{cliente: object|null, pratiche: object[]}} dati  cliente già trovato dal mittente; pratiche aperte
 * @returns {{cliente_id: number|null, pratica_id: number|null}}
 */
function abbina(mail, { cliente, pratiche }) {
  const cliente_id = cliente?.id ?? null;
  const testo = `${mail.oggetto || ''}\n${String(mail.testo || '').slice(0, 20000)}`;

  const trovate = pratiche
    .map((p) => ({ p, punti: codiciPratica(p).filter((c) => contieneCodice(testo, c)).length }))
    .filter((x) => x.punti > 0)
    .sort((a, b) => (b.punti - a.punti) || ((b.p.cliente_id === cliente_id) - (a.p.cliente_id === cliente_id)));
  if (trovate.length) {
    const p = trovate[0].p;
    return { cliente_id, pratica_id: p.id };
  }
  if (cliente_id) {
    const sue = pratiche.filter((p) => p.cliente_id === cliente_id);
    return { cliente_id, pratica_id: sue.length === 1 ? sue[0].id : null };
  }
  return { cliente_id: null, pratica_id: null };
}

module.exports = { abbina, codiciPratica, contieneCodice };
