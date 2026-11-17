#!/usr/bin/env bash
# Collegamento in SOLA LETTURA tra Google Drive (cartella dei lavori) e l'area clienti.
#
# Uso, sul server come root, dopo installa-server.sh:
#   bash configura-drive.sh /root/chiave-drive.json
#
# - Usa un "account di servizio" Google: vede solo le cartelle condivise con lui, in sola lettura.
# - Si sceglie lavoro per lavoro: su Drive si condivide la cartella del lavoro con l'account di
#   servizio (come Visualizzatore) e il lavoro arriva sul server; togliendo la condivisione esce.
# - Copia sul server solo ciò che serve all'area clienti (minimizzazione dei dati, art. 5 GDPR):
#   cartelle dei lavori e delle pratiche, sottocartelle "Presentazione", ricevute PDF, _cliente.txt.
#   Non copia mai documenti d'identità e gli altri file con nomi "sensibili" (stessi criteri dell'app).
# - Ogni 5 minuti allinea il server a Drive. Su Drive non scrive e non cancella nulla.
# - I documenti caricati dai clienti restano sul server ("Documenti dal cliente") e si scaricano dal pannello.
set -euo pipefail

CHIAVE="${1:-}"
DIR=/opt/area-clienti
if [ "$(id -u)" -ne 0 ]; then echo "Esegui come root"; exit 1; fi
if [ -z "$CHIAVE" ] && [ -f /etc/area-clienti/drive-chiave.json ]; then
  echo "==> Chiave già presente: aggiorno solo le impostazioni"
elif [ ! -f "$CHIAVE" ]; then
  echo "Uso: bash configura-drive.sh /percorso/chiave.json"; exit 1
fi

echo "==> Installazione di rclone"
command -v rclone >/dev/null || apt-get -o DPkg::Lock::Timeout=1800 -y -q install rclone

install -d -m 700 /etc/area-clienti
if [ -n "$CHIAVE" ]; then
  echo "==> Chiave dell'account di servizio"
  install -m 600 "$CHIAVE" /etc/area-clienti/drive-chiave.json
  shred -u "$CHIAVE" 2>/dev/null || rm -f "$CHIAVE"
fi

# Cartella madre facoltativa (es. «Studio Innocenti»): CARTELLA_MADRE=<id della cartella> bash configura-drive.sh
# Una volta condivisa con il server, ogni nuova sottocartella diventa da sola un lavoro da confermare.
if [ -n "${CARTELLA_MADRE:-}" ]; then echo "$CARTELLA_MADRE" > /etc/area-clienti/cartella-madre; fi
MADRE="$(cat /etc/area-clienti/cartella-madre 2>/dev/null || true)"

cat > /etc/area-clienti/rclone.conf <<EOF
[drive]
type = drive
scope = drive.readonly
service_account_file = /etc/area-clienti/drive-chiave.json
shared_with_me = true
skip_gdocs = true

[studio]
type = drive
scope = drive.readonly
service_account_file = /etc/area-clienti/drive-chiave.json
root_folder_id = ${MADRE:-nessuna}
skip_gdocs = true
EOF
chmod 600 /etc/area-clienti/rclone.conf

# Cosa copiare: le regole sono lette dall'alto, vince la prima che corrisponde
cat > /etc/area-clienti/filtro-drive.txt <<'EOF'
# Mai sul server: documenti d'identità e altri file sensibili (anche dentro Presentazione)
# (le regole non distinguono maiuscole e minuscole: rclone gira con --ignore-case)
- /**/*{carta*identit,cartaidentit,documento*identit,doc ide,docide,doc id,docid,passaporto,permesso*soggiorno,codice*fiscale,tessera*sanitaria,isee,busta*paga,estratto*conto,certificat*medic,referto,procura,delega,conferimento}*
# Sì: documenti delle imprese nella cartella Sicurezza del lavoro (visura, DURC, patente a crediti)
+ /*/*sicurezza*/**.{pdf,p7m}
- /**/*patente*
- *.{eml,msg,zip,rar,7z,tar,gz,tgz}
# Le cartelle "Documenti dal cliente" esistono solo sul server: non toccarle
- /**/Documenti dal cliente/**
# Sì: tutto il contenuto delle cartelle Presentazione
+ /**/Presentazione/**
# Sì: scheda cliente e ricevute PDF (piccole)
+ /**/_cliente.txt
+ /**/*.{pdf,p7m}
# Tutto il resto resta solo su Drive
- *
EOF
# Stesse regole, viste dall'interno di una singola cartella di lavoro
sed 's#^+ /\*/\*sicurezza\*#+ /*sicurezza*#' /etc/area-clienti/filtro-drive.txt > /etc/area-clienti/filtro-lavoro.txt

if [ -n "$MADRE" ]; then
  echo "==> Controllo dell'accesso alla cartella madre"
  # Drive risponde «nessuna cartella» (senza errore) se la cartella madre non è condivisa: serve almeno una cartella
  if [ -z "$(rclone --config /etc/area-clienti/rclone.conf lsf studio: --dirs-only --max-depth 1 2>/dev/null | head -1)" ]; then
    echo
    echo "!! Il server non vede ancora la cartella madre."
    echo "   Su Google Drive: tasto destro su «Studio Innocenti» → Condividi → aggiungi"
    echo "   $(grep -o '"client_email": *"[^"]*"' /etc/area-clienti/drive-chiave.json | sed 's/.*"\([^"]*\)"$/\1/')"
    echo "   come Visualizzatore, poi rilancia questo comando."
    exit 1
  fi
fi

cat > /usr/local/bin/area-clienti-drive <<'FINE'
#!/bin/bash
# Copia da Google Drive per l'area clienti (lanciata ogni 5 minuti dal timer di systemd)
set -u
CONF=/etc/area-clienti
DOC=/opt/area-clienti/documenti
DATI=/opt/area-clienti/dati
RC=(rclone --config "$CONF/rclone.conf")
OPZ=(--ignore-case --max-size 30M --create-empty-src-dirs --fast-list --transfers 4 --checkers 8 --log-level NOTICE)
exec 9>/run/area-clienti-drive.lock
flock -n 9 || exit 0

if [ ! -s "$CONF/cartella-madre" ]; then
  # Modalità a cartelle condivise una per una
  exec "${RC[@]}" sync drive: "$DOC" --filter-from "$CONF/filtro-drive.txt" "${OPZ[@]}"
fi

# Modalità cartella madre: elenco delle cartelle di lavoro (escluse quelle che iniziano con _ . @ #)
ELENCO=$(mktemp)
trap 'rm -f "$ELENCO"' EXIT
if ! "${RC[@]}" lsf studio: --dirs-only --format p > "$ELENCO.grezzo"; then
  rm -f "$ELENCO.grezzo"; echo "Google Drive non raggiungibile: riprovo al prossimo giro"; exit 1
fi
sed 's#/$##' "$ELENCO.grezzo" | grep -v '^[_.@#]' > "$ELENCO" || true
rm -f "$ELENCO.grezzo"
# Elenco vuoto = cartella madre non condivisa con il server: non si tocca niente
[ -s "$ELENCO" ] || { echo "Nessuna cartella visibile in Studio Innocenti: condividila con il server come Visualizzatore"; exit 1; }
install -m 644 "$ELENCO" "$DATI/drive-cartelle.txt"

# Le cartelle già presenti all'attivazione non vengono proposte (si aggiungono a mano dal pannello)
[ -f "$CONF/cartelle-iniziali.txt" ] || cp "$ELENCO" "$CONF/cartelle-iniziali.txt"
touch "$DATI/drive-lavori.txt"

# Cartelle nuove: segnaposto vuoto, il pannello le propone come lavori da confermare
while IFS= read -r n; do
  grep -qxF -- "$n" "$CONF/cartelle-iniziali.txt" || mkdir -p -- "$DOC/$n"
done < "$ELENCO"

# Lavori confermati nel pannello: copia dei documenti (stesse regole di riservatezza)
while IFS= read -r n; do
  [ -n "$n" ] && grep -qxF -- "$n" "$ELENCO" || continue
  "${RC[@]}" sync "studio:$n" "$DOC/$n" --filter-from "$CONF/filtro-lavoro.txt" "${OPZ[@]}" < /dev/null
done < "$DATI/drive-lavori.txt"

# Segnaposto di cartelle sparite da Drive e mai confermate: tolti solo se vuoti.
# I lavori confermati restano anche se la cartella viene spostata o archiviata su Drive.
for d in "$DOC"/*/; do
  [ -d "$d" ] || continue
  n=$(basename "$d")
  grep -qxF -- "$n" "$ELENCO" || grep -qxF -- "$n" "$DATI/drive-lavori.txt" || rmdir -- "$d" 2>/dev/null || true
done
FINE
chmod 700 /usr/local/bin/area-clienti-drive

echo "==> Area clienti in modalità Google Drive (cartelle e file si gestiscono su Drive)"
grep -q '^ARCHIVIO_SOLA_LETTURA=' "$DIR/.env" || echo 'ARCHIVIO_SOLA_LETTURA=true' >> "$DIR/.env"

echo "==> Prima copia da Drive (può richiedere qualche minuto)"
/usr/local/bin/area-clienti-drive
chown -R 1000:1000 "$DIR/documenti"

cat > /etc/systemd/system/area-clienti-drive.service <<EOF
[Unit]
Description=Copia da Google Drive per l'area clienti
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/area-clienti-drive
ExecStartPost=/bin/chown -R 1000:1000 $DIR/documenti
EOF
cat > /etc/systemd/system/area-clienti-drive.timer <<'EOF'
[Unit]
Description=Copia da Google Drive ogni 5 minuti
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now area-clienti-drive.timer >/dev/null
(cd "$DIR" && docker compose pull -q && docker compose up -d) >/dev/null

echo
echo "=================================================================="
echo " Collegamento con Google Drive attivo (sola lettura, ogni 5 minuti)."
[ -n "$MADRE" ] && echo " Cartella madre attiva: le nuove cartelle compaiono da sole tra i lavori da confermare."
echo " Lavori copiati: $(find $DIR/documenti -mindepth 1 -maxdepth 1 -type d | wc -l)"
echo " File copiati:   $(find $DIR/documenti -type f | wc -l)"
echo "=================================================================="
