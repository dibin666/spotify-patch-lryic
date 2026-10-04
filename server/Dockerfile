# Spot-Lyric lyrics server. Build from the repository root:
#   docker build -f server/Dockerfile -t spot-lyric-server .
# (server/docker-compose.yml does this for you)
# Static Go binary on an empty image (~7 MB) instead of Node (~160 MB).
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY server/go.mod ./
COPY server/*.go ./
COPY VERSION /VERSION
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$(cat /VERSION)" -o /out/spot-lyric-server . \
 && mkdir -p /out/data && chown 65532:65532 /out/data

FROM scratch
# CA certificates: HTTPS to R2 / NetEase / QQ Music.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/spot-lyric-server /spot-lyric-server
COPY --from=build --chown=65532:65532 /out/data /data

ENV HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["/spot-lyric-server", "healthcheck"]
ENTRYPOINT ["/spot-lyric-server"]
