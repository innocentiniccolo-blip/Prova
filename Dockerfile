# Debian slim: disponibile anche per i NAS ARM a 32 bit (linux/arm/v7)
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    ARCHIVIO_DIR=/archivio \
    DATI_DIR=/dati \
    PORT=3000 \
    TZ=Europe/Rome

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/accedi').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
