Parent DOX: [web](../AGENTS.md).

# Purpose

Stable anonymous login surface, independent of application releases.

# Ownership

Own `index.html`, `login.js` and `login.css`. The server owns anonymous routing and the explicit login catalog projection; the shared JSON catalogs remain the only translation source.

# Local Contracts

- Copy these sources verbatim into the login HTML; no bundler, minifier, application imports, dependency versions or release metadata. Login loads only its fixed logo and favicon URLs. Public social metadata uses static branding.
- Keep public bytes, language choices, messages, response schemas and CSP independent of application changes. The anonymous response baseline in `internal/server/testdata/login-surface.json` is a release contract, not a routinely refreshed snapshot. Changing it requires an explicit login/security requirement and acknowledging the fingerprint change.
- Preserve credential-safe language selection, instance-prefixed language cookies, RTL, native validation/picker accessibility, touch keyboard sizing and same-origin login. Successful login and logout navigate to `/` to cross the authentication boundary and fetch the appropriate page.
- Keep the small login helpers self-contained so changes to shared application utilities cannot fingerprint releases. Never persist passwords or fetch the application/catalog/assets before authentication.

# Work Guidance

Fix security and accessibility defects even if they require changing public bytes; never promise protocol-level anonymity.

# Verification

Run the server anonymous-surface tests, `npm run check:i18n`, `node tests/login-security.mjs`, `node tests/login-language.mjs` and the i18n browser suite after changes here.

# Child DOX Index

No children.
