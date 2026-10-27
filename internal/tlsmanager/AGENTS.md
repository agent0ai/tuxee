Parent DOX: [internal](../AGENTS.md).

# Purpose

Native TLS with automatic public issuance and persistent local-CA fallback.

# Ownership

Own certificate selection, CA/account keys, TLS-ALPN challenge presentation, bounded enrollment, and renewal status.

# Local Contracts

Cached TLS status carries structured i18n `text` alongside diagnostic `error`; preserve nested causes and clear both on successful renewal. Status is shared across users and remains language-independent.

Use TLS-ALPN-01 on the existing listener, never a mandatory port 80 listener. Public port 443 may forward to any local TLS port. ACME auto/on enrolls eligible public domains on demand from TLS SNI; configured hosts are optional startup targets and select the no-SNI identity. Without configured hosts, use discovered interface addresses for startup targets. Resolve names to exclusively public addresses before ordering; ACME validation proves reachability. Periodically renew all tracked names without browser traffic; retries are serialized and limited to once per hour per host. ACME off disables enrollment and renewal, not use of a valid cached certificate. Preserve a valid public certificate across renewal failures. When none is valid, serve a leaf from the persistent local CA and keep attempting public issuance. Never silently rotate an expired local CA or downgrade to HTTP. Store private material only in the protected server state directory. Do not enable HSTS by default. Public IP orders use the shortlived profile.

Invalid public certificate caches remain visible in status and fall back locally. The 64-host memory cache evicts inactive dynamic records while preserving startup hosts and pending orders. When no slot is available, serve an uncached local leaf without enrollment.

# Work Guidance

Adapt the8020/https local.ts, reachability.ts and certificate lifecycle policies to standard Go crypto and lego. Avoid implementing ACME protocol primitives. Keep issuance serialized and bounded; TLS handshakes never wait for an ACME order.

# Verification

Run `go test ./internal/tlsmanager -v`. Enrollment checks cover hostname normalization, unconfigured public host enrollment, private host rejection and retry throttling. Real local TLS handshakes check SNI enrollment without configured hosts on a nonstandard port, CA persistence, live certificate replacement/fallback, valid-public retention after renewal errors and IP TLS-ALPN presentation on the same listener. These tests do not contact a public CA. The system integration test verifies default enrollment on an ephemeral port against a local failing CA before any browser request.

# Child DOX Index

No children.
