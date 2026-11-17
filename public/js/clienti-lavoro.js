// Modulo del lavoro: persone e aziende collegate, ognuna con il suo ruolo e un pulsante «Rimuovi».
// Le aggiunte e le rimozioni diventano effettive solo premendo «Salva».

/** Rimuove (o rimette) una riga: una riga rimossa non invia il suo ruolo, quindi al salvataggio viene scollegata. */
function rimuovi(btn) {
  const riga = btn.closest('.collegato');
  const tolta = !riga.classList.contains('tolto');
  riga.classList.toggle('tolto', tolta);
  riga.querySelectorAll('input').forEach((i) => { i.disabled = tolta; });
  btn.textContent = tolta ? '↶ Annulla' : '✕ Rimuovi';
  let nota = riga.querySelector('.nota-tolto');
  if (tolta && !nota) {
    nota = document.createElement('small');
    nota.className = 'nota-tolto';
    nota.textContent = 'Verrà tolto dal lavoro quando premi Salva';
    riga.append(nota);
  } else if (!tolta && nota) nota.remove();
  // Una riga appena aggiunta e poi rimossa sparisce del tutto e torna nel menu
  if (tolta && riga.dataset.nuovo) {
    const { box, valore, testo, extra } = riga._origine;
    const opt = new Option(testo, valore);
    opt.dataset.email = extra;
    box.querySelector('select').append(opt);
    box.hidden = false;
    riga.remove();
  }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-rimuovi]');
  if (btn) rimuovi(btn);
});

document.querySelectorAll('[data-aggiungi]').forEach((box) => {
  const tipo = box.dataset.aggiungi; // "ruolo" (clienti) o "azienda"
  const lista = document.querySelector(`[data-collegati="${tipo}"]`);
  const select = box.querySelector('select');
  const spunte = box.querySelector('.ruoli-spunte');
  const btn = box.querySelector('[data-aggiungi-btn]');
  if (!lista || !select || !spunte || !btn) return;
  btn.hidden = false;

  btn.addEventListener('click', () => {
    const opt = select.selectedOptions[0];
    if (!opt || !opt.value) { select.focus(); return; }
    const scelto = spunte.querySelector('input:checked');
    const riga = document.createElement('div');
    riga.className = 'collegato nuovo';
    riga.dataset.nuovo = '1';
    riga._origine = { box, valore: opt.value, testo: opt.textContent, extra: opt.dataset.email || '' };
    const nome = document.createElement('span');
    nome.className = 'collegato-nome';
    nome.textContent = opt.textContent.replace(/\s*\([^)]*\)\s*$/, '') + ' ';
    const extra = document.createElement('small');
    extra.className = 'muto';
    extra.textContent = opt.dataset.email || '';
    nome.append(extra);
    const gruppo = spunte.cloneNode(true);
    gruppo.setAttribute('aria-label', `Ruolo di ${nome.textContent.trim()}`);
    gruppo.querySelectorAll('input').forEach((i) => {
      i.name = `${tipo}_${opt.value}`;
      i.checked = Boolean(scelto) && i.value === scelto.value;
    });
    const via = document.createElement('button');
    via.type = 'button';
    via.className = 'rimuovi';
    via.dataset.rimuovi = '1';
    via.textContent = '✕ Rimuovi';
    const nota = document.createElement('small');
    nota.className = 'nota-nuovo';
    nota.textContent = 'Nuovo: viene collegato quando premi Salva';
    riga.append(nome, gruppo, via, nota);
    lista.append(riga);
    const vuoto = lista.querySelector('[data-vuoto]');
    if (vuoto) vuoto.remove();
    opt.remove();
    select.value = '';
    if (select.options.length <= 1) box.hidden = true;
  });
});
