FROM node:22-trixie-slim AS frontend
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

FROM debian:trixie-slim AS gui
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl build-essential cmake ninja-build pkg-config autoconf automake libtool patch xutils-dev xfonts-utils xz-utils \
    libjpeg62-turbo-dev zlib1g-dev libx11-dev libxext-dev libxdamage-dev libxfixes-dev libxrandr-dev libxtst-dev \
    libxfont-dev xtrans-dev x11proto-dev libpixman-1-dev libxshmfence-dev libxkbfile-dev libfontenc-dev \
    libpam0g-dev libunwind-dev nettle-dev \
    && rm -rf /var/lib/apt/lists/*
COPY docker/build-gui.sh /build-gui.sh
RUN sh /build-gui.sh /output

FROM debian:trixie-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libpam0g libpam-modules libpam-runtime ca-certificates passwd bash procps 7zip tini curl \
    matchbox-window-manager xterm fonts-dejavu-core x11-xkb-utils xkb-data dbus \
    libnettle8t64 libunwind8 libjpeg62-turbo libpixman-1-0 libxfont2 libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /etc/tuxee /var/lib/tuxee \
    && chmod 0700 /var/lib/tuxee \
    && rm -f /var/log/apt/* /var/log/dpkg.log /var/cache/debconf/*-old /var/lib/dpkg/status-old
COPY --from=backend /tuxee /usr/local/lib/tuxee/tuxee
COPY --from=gui /output/ /
RUN ln -s /usr/local/lib/tuxee/tuxee /usr/local/bin/tuxee
COPY docker/tuxee.profile.sh /etc/profile.d/tuxee.sh
# Initialize ROOT_PASSWORD (default: toor) on the first container start.
COPY --chmod=0755 docker/entrypoint.sh /opt/tuxee/entrypoint.sh
COPY --chmod=0755 docker/docker-init.sh /opt/tuxee/docker-init.sh
COPY docker/init/README.md /init/README.md
COPY docker/tuxee.example.json /etc/tuxee/config.json
COPY THIRD_PARTY_NOTICES.md /opt/tuxee/THIRD_PARTY_NOTICES.md
EXPOSE 80 443
VOLUME ["/var/lib/tuxee", "/root", "/init"]
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s CMD ["/usr/local/bin/tuxee", "healthcheck", "--config", "/etc/tuxee/config.json"]
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/tuxee/entrypoint.sh", "/init"]
CMD ["/usr/local/bin/tuxee", "serve", "--config", "/etc/tuxee/config.json"]
