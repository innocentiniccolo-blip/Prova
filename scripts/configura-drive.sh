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

cat > /etc/area-clienti/rclone.conf <<EOF
[drive]
type = drive
scope = drive.readonly
service_account_file = /etc/area-clienti/drive-chiave.json
shared_with_me = true
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

cat > /usr/local/bin/area-clienti-drive <<EOF
#!/usr/bin/env bash
# Allinea l'archivio dell'area clienti con Google Drive (sola lettura su Drive)
exec flock -n /run/area-clienti-drive.lock \\
  rclone sync drive: $DIR/documenti \\
    --config /etc/area-clienti/rclone.conf \\
    --filter-from /etc/area-clienti/filtro-drive.txt --ignore-case \\
    --max-size 30M --create-empty-src-dirs \\
    --fast-list --transfers 4 --checkers 8 \\
    --log-level NOTICE
EOF
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
echo " Lavori copiati: $(find $DIR/documenti -mindepth 1 -maxdepth 1 -type d | wc -l)"
echo " File copiati:   $(find $DIR/documenti -type f | wc -l)"
echo "=================================================================="
