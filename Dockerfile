FROM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY web ./web
COPY third_party ./third_party
COPY THIRD_PARTY_NOTICES.md ./
RUN npm run build

# Keep the exported CGO/PAM binary compatible with Debian 12 native installations.
FROM golang:1.26.3-bookworm AS backend
RUN apt-get update && apt-get install -y --no-install-recommends libpam0g-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /build/web/dist ./web/dist
COPY --from=frontend /build/internal/terminal/engine.js ./internal/terminal/engine.js
ARG VERSION=0.0.0
RUN CGO_ENABLED=1 go build -trimpath -ldflags="-s -w -X main.version=${VERSION#v}" -o /tuxee ./cmd/tuxee

FROM scratch AS binary
COPY --from=backend /tuxee /tuxee

FROM debian:trixie-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libpam0g libpam-modules libpam-runtime ca-certificates passwd bash procps 7zip tini curl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /etc/tuxee /var/lib/tuxee \
    && chmod 0700 /var/lib/tuxee \
    && rm -f /var/log/apt/* /var/log/dpkg.log /var/cache/debconf/*-old /var/lib/dpkg/status-old
COPY --from=backend /tuxee /usr/local/lib/tuxee/tuxee
RUN ln -s /usr/local/lib/tuxee/tuxee /usr/local/bin/tuxee
COPY docker/tuxee.profile.sh /etc/profile.d/tuxee.sh
# Initialize ROOT_PASSWORD (default: toor) on the first container start.
COPY --chmod=0755 docker/entrypoint.sh /opt/tuxee/entrypoint.sh
COPY --chmod=0755 docker/docker-init.sh /opt/tuxee/docker-init.sh
COPY docker/init/README.md /init/README.md
COPY docker/tuxee.example.json /etc/tuxee/config.json
COPY THIRD_PARTY_NOTICES.md /opt/tuxee/THIRD_PARTY_NOTICES.md
EXPOSE 443
VOLUME ["/var/lib/tuxee", "/root", "/init"]
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s CMD curl --fail --silent --show-error --insecure --max-time 4 https://127.0.0.1/health
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/tuxee/entrypoint.sh", "/init"]
CMD ["/usr/local/bin/tuxee", "serve", "--config", "/etc/tuxee/config.json"]
