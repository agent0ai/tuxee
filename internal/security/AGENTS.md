Parent DOX: [internal](../AGENTS.md).

# Purpose

Small authentication primitives and instance network policy.

# Ownership

Own TOTP, recovery-code hashing, IP/CIDR parsing, trusted-proxy resolution and atomic network-policy storage. Files owns per-user persistence; server owns admission and enrollment.

# Local Contracts

- Empty allowed networks permits all; otherwise require an exact IP or IPv4/IPv6 CIDR match. No wildcard, DNS or implicit loopback exemption. Trust X-Forwarded-For only through explicitly trusted proxy networks, walking from the immediate peer toward the first untrusted address.
- Store instance policy in `security.json` in the protected instance state directory. Read changes without restart; malformed/unreadable policy fails closed. Atomic writes preserve a complete policy.
- TOTP uses six digits, HMAC-SHA1, 30-second steps and a one-step clock tolerance. Persist the last accepted step and consume recovery-code hashes once. Never log secrets or codes.

# Work Guidance

Use standard-library cryptography and networking; QR encoding is the only additional dependency.

# Verification

`go test ./internal/security` checks RFC TOTP vectors, replay, recovery codes, IP parsing, proxy spoofing and policy persistence.

# Child DOX Index

No children.
