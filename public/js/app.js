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

// Filtro tabelle per stato (pagina Pratiche)
document.querySelectorAll('[data-filtro-stato]').forEach((sel) => {
  const chiusi = JSON.parse(document.getElementById('stati-chiusi')?.textContent || '[]');
  const ricerca = document.querySelector(`[data-filtro="${sel.dataset.filtroStato}"]`);
  const applica = () => {
    const v = sel.value;
    const q = (ricerca?.value || '').trim().toLowerCase();
    document.querySelectorAll(sel.dataset.filtroStato).forEach((r) => {
      const s = r.dataset.stato;
      const okStato = !v || (v === '__aperte' ? !chiusi.includes(s) : s === v);
      r.hidden = !okStato || (q && !r.textContent.toLowerCase().includes(q));
    });
  };
  sel.addEventListener('change', applica);
  ricerca?.addEventListener('input', applica);
  applica();
});

// Cambio stato immediato
document.querySelectorAll('[data-invia-al-cambio]').forEach((s) => s.addEventListener('change', () => s.form.submit()));

// Compositore email / WhatsApp con bozza AI
document.querySelectorAll('[data-compositore]').forEach((form) => {
  const canale = () => form.querySelector('input[name="canale"]:checked').value;
  const invia = form.querySelector('[data-invia-btn]');
  const esito = form.querySelector('[data-esito-ai]');
  const aggiornaCanale = () => {
    const c = canale();
    form.querySelectorAll('[data-solo]').forEach((el) => { el.hidden = el.dataset.solo !== c; });
    invia.textContent = c === 'whatsapp' ? 'Apri in WhatsApp' : 'Apri email';
  };
  form.querySelectorAll('input[name="canale"]').forEach((r) => r.addEventListener('change', aggiornaCanale));
  aggiornaCanale();

  form.querySelector('[data-contatto]')?.addEventListener('change', (e) => {
    const o = e.target.selectedOptions[0];
    form.elements.destinatario_nome.value = o.dataset.nome || '';
    form.elements.email.value = o.dataset.email || '';
    form.elements.telefono.value = o.dataset.telefono || '';
  });

  form.querySelectorAll('[data-suggerimento]').forEach((b) => b.addEventListener('click', () => {
    form.elements.istruzioni.value = b.dataset.suggerimento;
    form.elements.istruzioni.focus();
  }));

  const btnAi = form.querySelector('[data-genera-btn]');
  btnAi?.addEventListener('click', async () => {
    const testo = form.elements.testo;
    if (testo.value.trim() && !confirm('Sostituire il testo già scritto con una nuova bozza?')) return;
    btnAi.disabled = true;
    const etichetta = btnAi.textContent;
    btnAi.textContent = 'Sto scrivendo…';
    esito.hidden = true;
    try {
      const r = await fetch(form.dataset.genera, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': form.elements._csrf.value },
        body: JSON.stringify({
          canale: canale(),
          destinatario_nome: form.elements.destinatario_nome.value,
          istruzioni: form.elements.istruzioni.value,
        }),
      });
      const dati = await r.json().catch(() => ({ errore: 'Risposta non valida dal server.' }));
      if (!r.ok) throw new Error(dati.errore || 'Errore');
      if (canale() === 'email') form.elements.oggetto.value = dati.oggetto;
      testo.value = dati.testo;
      esito.textContent = 'Bozza pronta: rileggila e correggi i punti tra [parentesi quadre] prima di inviare.';
      esito.hidden = false;
      testo.focus();
    } catch (err) {
      esito.textContent = err.message;
      esito.hidden = false;
    } finally {
      btnAi.disabled = false;
      btnAi.textContent = etichetta;
    }
  });

  form.querySelector('[data-copia-testo]')?.addEventListener('click', async (e) => {
    const t = [form.elements.oggetto.value && canale() === 'email' ? `Oggetto: ${form.elements.oggetto.value}\n` : '', form.elements.testo.value].join('');
    await navigator.clipboard.writeText(t);
    e.target.textContent = 'Copiato ✓';
  });

  form.addEventListener('submit', () => {
    // WhatsApp in una nuova scheda; la pagina si ricarica per mostrare lo storico aggiornato
    form.target = canale() === 'whatsapp' ? '_blank' : '';
    setTimeout(() => location.reload(), 1500);
  });
});
