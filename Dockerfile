FROM node:22-alpine

ENV NODE_ENV=production \
    ARCHIVIO_DIR=/archivio \
    DATI_DIR=/dati \
    PORT=3000 \
    TZ=Europe/Rome

RUN apk add --no-cache tzdata
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
