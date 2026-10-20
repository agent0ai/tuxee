Parent DOX: [project](../AGENTS.md).

# Purpose

Redistribution licenses for bundled code and adapted source.

# Ownership

Own verbatim upstream license/notice copies. THIRD_PARTY_NOTICES.md at the root owns attribution and adaptation notes.

# Local Contracts

Preserve copied license text unchanged. Refresh relevant notices when dependency versions or reused sources change. The frontend build embeds these files in the binary under /licenses/.

# Work Guidance

Copy notices from the exact installed dependency or inspected source version.

# Verification

`npm run build` copies notices into the embedded assets. `go list -deps -f '{{if .Module}}{{.Module.Dir}}{{end}}' ./cmd/tuxee` identifies linked Go dependency source directories.

# Child DOX Index

No children.
