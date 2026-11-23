// Schede delle categorie documenti
document.querySelectorAll('[data-schede]').forEach((box) => {
  const titoli = box.querySelectorAll('[data-scheda]');
  const mostra = (chiave) => {
    titoli.forEach((t) => t.classList.toggle('attiva', t.dataset.scheda === chiave));
    box.querySelectorAll('[data-pannello]').forEach((p) => p.classList.toggle('attiva', p.dataset.pannello === chiave));
  };
  titoli.forEach((t) => t.addEventListener('click', () => {
    mostra(t.dataset.scheda);
    history.replaceState(null, '', '#' + t.dataset.scheda);
  }));
  const h = location.hash.slice(1);
  if (h && box.querySelector(`[data-scheda="${CSS.escape(h)}"]`)) mostra(h);
});

// Conferma prima di azioni distruttive
document.addEventListener('submit', (e) => {
  const msg = e.target.dataset.conferma;
  if (msg && !confirm(msg)) e.preventDefault();
});

// Copia credenziali
document.querySelectorAll('[data-copia]').forEach((b) => b.addEventListener('click', async () => {
  await navigator.clipboard.writeText(document.querySelector(b.dataset.copia).innerText);
  b.textContent = 'Copiato ✓';
}));

// Filtro tabelle
document.querySelectorAll('[data-filtro]').forEach((input) => input.addEventListener('input', () => {
  const q = input.value.trim().toLowerCase();
  document.querySelectorAll(input.dataset.filtro).forEach((r) => {
    r.hidden = q && !r.textContent.toLowerCase().includes(q);
  });
}));
