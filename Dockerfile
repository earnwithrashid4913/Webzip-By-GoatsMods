# WebZip backend — single Node process, no build step.
# Startup command matches the Pterodactyl egg exactly: node src/server.js

FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TEMP_DIR=/tmp/webzip

WORKDIR /app

# Dependencies first, for layer caching.
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# The frontend is served as-is; nothing about it is compiled or rewritten.
COPY index.html ./
COPY src ./src
COPY storage ./storage

# Never run as root inside the container.
RUN chown -R node:node /app && mkdir -p /tmp/webzip && chown -R node:node /tmp/webzip
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
