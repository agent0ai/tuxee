FROM debian:trixie-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential musl-tools \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /experiment
COPY keeper.c Makefile ./
RUN make OUT=/out

FROM debian:trixie-slim AS runtime
COPY --from=build /out/keeper-musl /usr/local/bin/tuxee-keeper
COPY --from=build /usr/share/doc/musl/copyright /usr/share/doc/tuxee-keeper/musl-copyright

FROM agent0ai/tuxee:latest AS tuxee-runtime
COPY --from=build /out/keeper-musl /usr/local/lib/tuxee/tuxee-keeper
COPY --from=build /usr/share/doc/musl/copyright /usr/share/doc/tuxee-keeper/musl-copyright

FROM tuxee-runtime AS lifecycle-checks
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
COPY check.py /experiment/check.py
HEALTHCHECK NONE
CMD ["python3", "/experiment/check.py", "--service", "/usr/local/lib/tuxee/tuxee-keeper"]

FROM debian:trixie-slim AS checks
RUN apt-get update && apt-get install -y --no-install-recommends python3 tini procps \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/ /keepers/
COPY check.py /experiment/check.py
ENTRYPOINT ["/usr/bin/tini", "--", "python3", "/experiment/check.py"]
