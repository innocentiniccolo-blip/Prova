'use strict';
/** Conservazione limitata dei dati (art. 5.1.e GDPR): cancellazioni automatiche giornaliere. */
const db = require('./db');

const MESI_CONSULTAZIONI = 12;
const q = {
  consultazioni: db.prepare(`DELETE FROM accessi_file WHERE creato_il < datetime('now', ?)`),
  link: db.prepare('DELETE FROM link_password WHERE scade < ? OR usato = 1'),
};

function esegui() {
  const n = q.consultazioni.run(`-${MESI_CONSULTAZIONI} months`).changes;
  q.link.run(Date.now());
  require('./arrivi').pulisci(); // registro dei documenti arrivati dalle imprese: 12 mesi
  if (n) console.log(`[privacy] Cancellate ${n} consultazioni più vecchie di ${MESI_CONSULTAZIONI} mesi`);
  return n;
}
function avvia() {
  try { esegui(); } catch (e) { console.error(e); }
  setInterval(() => { try { esegui(); } catch (e) { console.error(e); } }, 24 * 60 * 60 * 1000).unref();
}

module.exports = { esegui, avvia, MESI_CONSULTAZIONI };
