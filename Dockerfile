# ---------- build the frontend ----------
FROM node:22-slim AS webbuild
WORKDIR /app
COPY web/package.json web/package-lock.json* ./web/
RUN cd web && npm ci --no-audit --no-fund
COPY web ./web
RUN cd web && npm run build

# ---------- install server deps (native better-sqlite3 build happens here) ----------
FROM node:22-slim AS serverdeps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- runtime ----------
FROM node:22-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3391
WORKDIR /app

COPY --from=serverdeps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY --from=webbuild /app/web/dist ./web/dist

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3391

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
