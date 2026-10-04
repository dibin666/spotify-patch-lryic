# Spot-Lyric lyrics server. Build from the repository root:
#   docker build -f server/Dockerfile -t spot-lyric-server .
# (server/docker-compose.yml does this for you)
FROM node:24-alpine

WORKDIR /app
# Same layout as the repository: server/src/server.js loads ../../src/core.js
COPY VERSION ./VERSION
COPY src/core.js ./src/core.js
COPY server/package.json ./server/package.json
COPY server/src ./server/src

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "server/src/server.js"]
