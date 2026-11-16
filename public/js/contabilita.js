'use strict';
(() => {
  const form = document.getElementById('form-notula');
  if (form) {
    const importo = (v) => {
      let t = String(v || '').replace(/[€\s]/g, '');
      if (!t) return 0;
      if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
      const n = parseFloat(t);
      return Number.isFinite(n) ? Math.round(n * 100) : 0;
    };
    const perc = (n, d) => { const x = parseFloat(String(form.elements[n].value).replace(',', '.')); return Number.isFinite(x) ? x : d; };
    const somma = (nome) => [...form.querySelectorAll(`[name="${nome}"]`)].reduce((s, i) => s + importo(i.value), 0);
    const eur = (c) => (c / 100).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
    const aggiorna = () => {
      const compenso = somma('voce_importo');
      const cassa = Math.round(compenso * perc('cassa_pct', 5) / 100);
      const imponibile = compenso + cassa;
      const iva = Math.round(imponibile * perc('iva_pct', 22) / 100);
      const anticipate = somma('spesa_importo');
      const bollo = anticipate > 7747 ? 200 : 0;
      const totale = imponibile + iva + anticipate + bollo;
      const ritenuta = form.elements.sostituto.checked ? Math.round(compenso * 0.2) : 0;
      const v = { compenso, cassa, iva, anticipate, bollo, totale, ritenuta: -ritenuta, netto: totale - ritenuta };
      for (const [k, c] of Object.entries(v)) {
        const el = document.querySelector(`[data-t="${k}"]`);
        if (el) el.textContent = (k === 'totale' || k === 'netto' ? '' : '') + (k === 'ritenuta' ? '− ' + eur(-c) : eur(c));
      }
    };
    form.addEventListener('input', aggiorna);
    form.addEventListener('change', aggiorna);
    const nuovaRiga = (tipo) => {
      const d = document.createElement('div');
      d.className = 'riga-conta';
      d.innerHTML = `<input name="${tipo}_desc" placeholder="Descrizione" maxlength="300"><input name="${tipo}_importo" class="importo" placeholder="0,00" inputmode="decimal"><button type="button" class="link togli" title="Togli riga">✕</button>`;
      document.getElementById(tipo === 'voce' ? 'righe-voci' : 'righe-spese').appendChild(d);
      d.firstChild.focus();
    };
    form.addEventListener('click', (e) => {
      const add = e.target.closest('[data-aggiungi]');
      if (add) return nuovaRiga(add.dataset.aggiungi);
      if (e.target.closest('.togli')) { e.target.closest('.riga-conta').remove(); aggiorna(); }
    });
    form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault(); });
    aggiorna();
  }
})();
