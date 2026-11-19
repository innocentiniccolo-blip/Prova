// Il simbolo si compone solo alla prima pagina aperta (una volta per sessione del browser)
try {
  if (!sessionStorage.getItem('logoVisto')) {
    document.documentElement.classList.add('logo-compone');
    sessionStorage.setItem('logoVisto', '1');
  }
} catch { /* navigazione privata o archiviazione bloccata: niente animazione */ }
