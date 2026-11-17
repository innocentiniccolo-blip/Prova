// Modulo del lavoro: aggiunge clienti e aziende scelti dal menu a tendina, con il ruolo spuntato.
// Senza JavaScript funziona lo stesso: la scelta nel menu viene salvata con «Salva».
document.querySelectorAll('[data-aggiungi]').forEach((box) => {
  const tipo = box.dataset.aggiungi; // "ruolo" (clienti) o "azienda"
  const prefisso = tipo === 'ruolo' ? 'ruolo' : 'azienda';
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
      i.name = `${prefisso}_${opt.value}`;
      i.checked = scelto && i.value === scelto.value;
    });
    const togli = document.createElement('label');
    togli.className = 'togli';
    togli.innerHTML = '<input type="radio" value=""> Togli';
    togli.querySelector('input').name = `${prefisso}_${opt.value}`;
    gruppo.append(togli);
    riga.append(nome, gruppo);
    lista.append(riga);
    const vuoto = lista.querySelector('[data-vuoto]');
    if (vuoto) vuoto.remove();
    opt.remove();
    select.value = '';
    if (select.options.length <= 1) box.hidden = true;
  });
});
