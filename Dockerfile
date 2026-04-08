FROM node:22-slim

# No build-essential/python3 needed — opusscript is pure WASM
WORKDIR /app

# WORKDIR=/app is required: process.cwd() data path resolution depends on this
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

ENV NODE_ENV=production \
    MCP_ENABLED=true \
    MCP_PORT=3000 \
    MCP_HOST=0.0.0.0

EXPOSE 3000

# curl not available in node:22-slim — use Node.js fetch for healthcheck
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:3000/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "src/index.js"]
