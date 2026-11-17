#!/usr/bin/env bash
# Attiva l'antivirus ClamAV per i documenti che arrivano dalle imprese (link e email).
# Da eseguire una volta sul server, come root:  bash attiva-antivirus.sh
set -euo pipefail
DIR=/opt/area-clienti
cd "$DIR"

# ClamAV tiene in memoria le firme dei virus: servono circa 1,5 GB. Se la memoria è poca aggiunge 2 GB di swap.
ram=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
swap=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
echo "Memoria: ${ram} MB, swap: ${swap} MB"
if [ $((ram + swap)) -lt 3500 ] && [ ! -f /swapfile ]; then
  echo "==> Aggiungo 2 GB di swap"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Servizio antivirus"
cat > docker-compose.override.yml <<'EOF'
# Antivirus per i file in arrivo dalle imprese (aggiunto da attiva-antivirus.sh)
services:
  clamav:
    image: clamav/clamav:stable
    container_name: area-clienti-antivirus
    restart: unless-stopped
    volumes:
      - ./clamav:/var/lib/clamav
    logging:
      options: { max-size: "10m", max-file: "3" }
EOF
mkdir -p clamav

sed -i '/^CLAMAV_HOST=/d' .env
echo 'CLAMAV_HOST=clamav' >> .env

docker compose pull -q
docker compose up -d --remove-orphans
echo "==> Attendo che l'antivirus scarichi le firme (può richiedere qualche minuto)..."
for i in $(seq 1 60); do
  if docker exec area-clienti-antivirus clamdscan --ping 1 >/dev/null 2>&1; then echo "Antivirus attivo."; exit 0; fi
  sleep 10
done
echo "L'antivirus sta ancora partendo: ricontrolla tra qualche minuto con  docker logs area-clienti-antivirus"
