FROM node:24-bookworm-slim
ENV NODE_ENV=production PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium WHATSAPP_DATA_PATH=/app/.runtime/whatsapp
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY lib ./lib
COPY worker ./worker
RUN mkdir -p /app/.runtime/whatsapp && chown -R node:node /app
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "worker/index.mjs"]
