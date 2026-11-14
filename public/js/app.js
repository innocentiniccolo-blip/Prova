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
