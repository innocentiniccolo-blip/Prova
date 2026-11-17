// Apre la pratica indicata nell'indirizzo (es. dopo un salvataggio)
// (apre anche le sezioni ripiegate che la contengono, e lo stesso per i link interni alla pagina)
function apriSezione(hash) {
  const el = hash && hash.length > 1 && document.getElementById(decodeURIComponent(hash.slice(1)));
  if (!el) return;
  for (let d = el; d; d = d.parentElement) if (d.tagName === 'DETAILS') d.open = true;
  el.scrollIntoView({ block: 'start' });
}
apriSezione(location.hash);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (a) apriSezione(a.getAttribute('href'));
});

// Conferma prima di azioni distruttive
document.addEventListener('submit', (e) => {
  const msg = (e.submitter && e.submitter.dataset.conferma) || e.target.dataset.conferma;
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

// Moduli a spunte: il pulsante si attiva solo dopo aver cambiato qualcosa
document.querySelectorAll('form[data-modifiche]').forEach((f) => {
  const pulsante = f.querySelector('button');
  const nota = f.querySelector('[data-suggerimento]');
  const stato = () => [...f.querySelectorAll('input[type=checkbox]')].map((c) => c.checked).join();
  const iniziale = stato();
  const aggiorna = () => {
    const cambiato = stato() !== iniziale;
    pulsante.disabled = !cambiato;
    if (nota) nota.textContent = cambiato ? 'Modifiche da salvare.' : 'Spunta o togli la spunta a una cartella, poi salva.';
  };
  f.addEventListener('change', aggiorna);
  aggiorna();
});
