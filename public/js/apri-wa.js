// Apre WhatsApp con il promemoria già scritto (il link è un normale collegamento, non un invio di modulo)
const a = document.getElementById('apri-wa');
if (a && /^https:\/\/wa\.me\//.test(a.href)) location.href = a.href;
