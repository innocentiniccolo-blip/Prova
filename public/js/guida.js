'use strict';
// Guida dello studio: ricerca, spunte dei passaggi (salvate su questo dispositivo), stampa in PDF
(function () {
  const voci = Array.from(document.querySelectorAll('.guida-voce'));
  const passi = Array.from(document.querySelectorAll('.guida-passi li'));
  const CHIAVE = 'guida-spunte';
  let spunte = {};
  try { spunte = JSON.parse(localStorage.getItem(CHIAVE) || '{}') || {}; } catch { spunte = {}; }
  const salva = () => { try { localStorage.setItem(CHIAVE, JSON.stringify(spunte)); } catch { /* memoria del browser non disponibile */ } };

  passi.forEach((li, i) => {
    const id = `${li.closest('.guida-voce').id}-${i}`;
    if (spunte[id]) li.classList.add('fatto');
    li.addEventListener('click', (e) => {
      if (e.target.closest('code, a')) return;
      li.classList.toggle('fatto');
      if (li.classList.contains('fatto')) spunte[id] = 1; else delete spunte[id];
      salva();
    });
  });

  // Copia al tocco dei comandi e dell'indirizzo email
  document.querySelectorAll('code.copia').forEach((c) => {
    c.title = 'Tocca per copiare';
    c.addEventListener('click', () => {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(c.textContent.trim()).then(() => {
        c.classList.add('copiato');
        setTimeout(() => c.classList.remove('copiato'), 1500);
      }).catch(() => {});
    });
  });

  const filtro = document.getElementById('guida-filtro');
  const normalizza = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (filtro) filtro.addEventListener('input', () => {
    const q = normalizza(filtro.value.trim());
    voci.forEach((v) => {
      const trovata = !q || normalizza(v.textContent).includes(q);
      v.hidden = !trovata;
      if (q && trovata) v.open = true;
    });
  });

  const apri = document.getElementById('guida-apri');
  if (apri) apri.addEventListener('click', () => {
    const tutte = voci.every((v) => v.open);
    voci.forEach((v) => { v.open = !tutte; });
    apri.textContent = tutte ? 'Apri tutto' : 'Chiudi tutto';
  });
  const azzera = document.getElementById('guida-azzera');
  if (azzera) azzera.addEventListener('click', () => {
    spunte = {}; salva();
    passi.forEach((li) => li.classList.remove('fatto'));
  });

  // In stampa tutte le voci aperte; dopo, si ripristina com'era
  let aperte = [];
  window.addEventListener('beforeprint', () => { aperte = voci.map((v) => v.open); voci.forEach((v) => { v.open = true; v.hidden = false; }); });
  window.addEventListener('afterprint', () => { voci.forEach((v, i) => { v.open = aperte[i]; }); });
  const stampa = document.getElementById('guida-stampa');
  if (stampa) stampa.addEventListener('click', () => window.print());
})();
