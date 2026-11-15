#!/usr/bin/env bash
# Installazione dell'area clienti su un server Ubuntu 24.04 (es. Aruba Cloud VPS).
#
# Uso, dalla console del server come root:
#   curl -fsSL https://raw.githubusercontent.com/innocentiniccolo-blip/Prova/pratiche-per-sottocartella/scripts/installa-server.sh | bash -s area.geometrainnocenti.it
#
# Cosa fa:
#  - aggiornamenti di sicurezza automatici
#  - firewall: aperte solo le porte 22 (SSH), 80 e 443 (web)
#  - protezione dai tentativi di accesso ripetuti (fail2ban)
#  - Docker e l'area clienti, con HTTPS automatico (Caddy + Let's Encrypt)
#  - backup notturno del database (ultimi 30 giorni)
#  - aggiornamento automatico notturno dell'area clienti
# Lo script si può rilanciare senza problemi: non cancella dati.
set -euo pipefail

DOMINIO="${1:-area.geometrainnocenti.it}"
DIR=/opt/area-clienti
IMMAGINE=ghcr.io/innocentiniccolo-blip/prova:latest

if [ "$(id -u)" -ne 0 ]; then echo "Esegui come root (sudo -i)"; exit 1; fi
echo "==> Installazione area clienti per https://$DOMINIO"

export DEBIAN_FRONTEND=noninteractive
# Su un server appena creato gli aggiornamenti automatici occupano apt per qualche minuto: si aspetta
APT_ATTESA="-o DPkg::Lock::Timeout=1800"
echo "==> Aggiornamento del sistema"
apt-get $APT_ATTESA update -q
apt-get $APT_ATTESA -y -q -o Dpkg::Options::=--force-confold upgrade
apt-get $APT_ATTESA -y -q install ca-certificates curl ufw fail2ban unattended-upgrades sqlite3

echo "==> Aggiornamenti di sicurezza automatici"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
sed -i 's#^//\s*Unattended-Upgrade::Automatic-Reboot "false";#Unattended-Upgrade::Automatic-Reboot "true";#; s#^//\s*Unattended-Upgrade::Automatic-Reboot-Time "02:00";#Unattended-Upgrade::Automatic-Reboot-Time "04:00";#' /etc/apt/apt.conf.d/50unattended-upgrades || true

echo "==> Firewall"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
systemctl enable --now fail2ban >/dev/null

echo "==> Fuso orario"
timedatectl set-timezone Europe/Rome || true

if ! command -v docker >/dev/null; then
  echo "==> Installazione di Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get $APT_ATTESA update -q
  apt-get $APT_ATTESA -y -q install docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
systemctl enable --now docker >/dev/null

echo "==> Cartelle"
mkdir -p "$DIR"/{dati,documenti,backup,caddy-dati,caddy-config}
# L'app nel container gira come utente senza privilegi (uid 1000)
chown -R 1000:1000 "$DIR/dati" "$DIR/documenti"
chmod 700 "$DIR/dati"

# Impostazioni: create una volta sola, poi si modificano a mano (es. password email)
if [ ! -f "$DIR/.env" ]; then
  cat > "$DIR/.env" <<EOF
# Impostazioni dell'area clienti. Dopo una modifica: cd $DIR && docker compose up -d
URL_PUBBLICO=https://$DOMINIO
SOLO_AREA=true
COOKIE_SECURE=true
TRUST_PROXY=true
# Email dalla casella Aruba dello studio: inserisci la password e riavvia
SMTP_HOST=
SMTP_PORT=465
SMTP_USER=info@geometrainnocenti.it
SMTP_PASS=
MAIL_FROM=info@geometrainnocenti.it
# true = nuovi lavori e stati letti dalle ricevute applicati senza conferma
AUTO_CONFERMA=false
EOF
  chmod 600 "$DIR/.env"
fi

cat > "$DIR/Caddyfile" <<EOF
$DOMINIO {
  encode gzip
  request_body {
    max_size 210MB
  }
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    -Server
  }
  reverse_proxy studio:3000
}
EOF

cat > "$DIR/docker-compose.yml" <<EOF
services:
  studio:
    image: $IMMAGINE
    container_name: area-clienti
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./documenti:/archivio
      - ./dati:/dati
    logging:
      options: { max-size: "10m", max-file: "3" }
  caddy:
    image: caddy:2
    container_name: area-clienti-https
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy-dati:/data
      - ./caddy-config:/config
    depends_on: [studio]
    logging:
      options: { max-size: "10m", max-file: "3" }
EOF

echo "==> Backup notturno e aggiornamento automatico"
cat > /usr/local/bin/area-clienti-manutenzione <<EOF
#!/usr/bin/env bash
# Ogni notte: copia del database (30 giorni) e aggiornamento dell'area clienti
set -e
cd $DIR
stamp=\$(date +%Y-%m-%d)
if [ -f dati/studio.sqlite ]; then
  sqlite3 dati/studio.sqlite ".backup 'backup/studio-\$stamp.sqlite'"
fi
find backup -name 'studio-*.sqlite' -mtime +30 -delete
docker compose pull -q && docker compose up -d --remove-orphans
docker image prune -f >/dev/null
EOF
chmod 700 /usr/local/bin/area-clienti-manutenzione
cat > /etc/cron.d/area-clienti <<'EOF'
30 3 * * * root /usr/local/bin/area-clienti-manutenzione >> /var/log/area-clienti-manutenzione.log 2>&1
EOF

echo "==> Avvio"
cd "$DIR"
docker compose pull -q
docker compose up -d --remove-orphans

echo "==> Attendo l'avvio dell'area clienti..."
for i in $(seq 1 30); do
  if docker logs area-clienti 2>&1 | grep -q "codice:"; then break; fi
  if docker logs area-clienti 2>&1 | grep -qi "in ascolto\|listening"; then break; fi
  sleep 2
done

IP=$(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
CODICE=$(docker logs area-clienti 2>&1 | grep -o "codice: [A-F0-9]*" | tail -1 | cut -d' ' -f2 || true)
echo
echo "=================================================================="
echo " Area clienti installata."
echo " Indirizzo del server (IP): $IP"
echo " Indirizzo dell'area clienti: https://$DOMINIO"
echo "   (funziona appena il dominio punta a questo IP; HTTPS automatico)"
if [ -n "$CODICE" ]; then
  echo
  echo " PRIMO AVVIO - codice di configurazione: $CODICE"
  echo " Apri https://$DOMINIO/configura e crea l'account dello studio."
fi
echo
echo " Impostazioni: $DIR/.env   Documenti: $DIR/documenti"
echo "=================================================================="
