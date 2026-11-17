# Debian slim: disponibile anche per i NAS ARM a 32 bit (linux/arm/v7)
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    ARCHIVIO_DIR=/archivio \
    DATI_DIR=/dati \
    PORT=3000 \
    TZ=Europe/Rome

# Lettura dei PDF fotografati (es. patente a crediti stampata dal portale INL): OCR in italiano
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-ita poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

# L'app gira con un utente senza privilegi (uid 1000), non come root
RUN mkdir -p /dati /archivio && chown -R node:node /dati /archivio
USER node

EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/accedi').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
