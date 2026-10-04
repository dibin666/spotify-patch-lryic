# Spot-Lyric lyrics server. Build from the repository root:
#   docker build -f server/Dockerfile -t spot-lyric-server .
# (server/docker-compose.yml does this for you)
# The image runs `spot-lyric serve`: the same program that patches Spotify and runs
# the local service, as a static binary on an empty image (~10 MB).
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod *.go VERSION ./
COPY src/ ./src/
COPY server/*.go ./server/
COPY patcher/ ./patcher/
COPY cmd/ ./cmd/
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/spot-lyric-server ./cmd/spot-lyric \
 && mkdir -p /out/data && chown 1000:1000 /out/data \
 && mkdir -p /out/etc \
 && echo 'node:x:1000:1000:node:/data:/sbin/nologin' > /out/etc/passwd \
 && echo 'node:x:1000:' > /out/etc/group

FROM scratch
# CA certificates: HTTPS to R2 / NetEase / QQ Music.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/spot-lyric-server /spot-lyric-server
COPY --from=build /out/etc/passwd /out/etc/group /etc/
COPY --from=build --chown=1000:1000 /out/data /data

ENV HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data
# Same user name / uid as the old Node image, so `user: node` and existing /data volumes keep working.
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["/spot-lyric-server", "healthcheck"]
ENTRYPOINT ["/spot-lyric-server", "serve"]
