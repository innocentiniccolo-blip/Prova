// Apre la pratica indicata nell'indirizzo (es. dopo un salvataggio)
const daAprire = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
if (daAprire && daAprire.tagName === 'DETAILS') daAprire.open = true;

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

// Invio documenti del cliente: controllo dimensione prima di spedire e blocco del doppio invio
document.querySelectorAll('[data-invio]').forEach((f) => f.addEventListener('submit', (e) => {
  const file = [...f.querySelector('input[type=file]').files];
  const grande = file.find((x) => x.size > 25 * 1024 * 1024);
  if (grande) { e.preventDefault(); alert(`"${grande.name}" supera i 25 MB. Riduci il file o dividilo in più parti.`); return; }
  if (file.length > 8) { e.preventDefault(); alert('Puoi inviare al massimo 8 file per volta.'); return; }
  f.classList.add('in-corso');
  f.querySelector('button').textContent = 'Invio in corso…';
}));
