Parent DOX: [internal](../AGENTS.md).

# Purpose

Filesystem operations and per-user configuration through an unprivileged worker.

# Ownership

Own worker requests, streaming file transfer, collision policy, atomic configuration writes, metadata, text editing, and native archive tools.

# Local Contracts

Worker responses carry structured `text: {key, vars}` beside diagnostic `error`; the client reconstructs typed i18n errors. Streaming helper failures carry the same metadata in bounded stderr, including failures before the first response header. Keep external archive-tool output as a variable, never as a translation key. Selection/editor limits in text come from the constants that enforce them.

`trash.go` owns FreeDesktop trash under the worker's credentials: `$XDG_DATA_HOME/Trash` (default `~/.local/share/Trash`) on the home mount, otherwise sticky `.Trash/$uid` or `.Trash-$uid` at the source mount root. The worker's clean account environment uses the home default; never inherit the server account's XDG location. Reuse existing directories/metadata; browsing creates nothing. Validate private directory ownership/modes and reject symlinks, pin directories and lock mutations. Write exclusive, synced, percent-encoded Path/DeletionDate metadata before no-replace rename; volume paths are mount-relative. Never silently delete or copy across filesystems after a trash failure. Reject filesystem roots and trash directories/ancestors/contents. Restore needs valid bounded metadata, an existing original parent and a free destination; failure preserves payloads. Delete/empty remove payloads before metadata without following directory symlinks. Listing combines home and mounted bins, caps rows at 10,000 and includes original paths/dates; orphan payloads remain visible for explicit deletion. Restore/delete accept only direct payloads of this account's discovered bins. `delete` remains explicit permanent deletion. No automatic expiry.

The server must execute the worker through identity.User.Command. All filesystem syscalls then use that user's credentials, including supplementary groups. Paths may access any location allowed by Linux; the home is a default, not an artificial jail. Stream data and reject explicit destination collisions. Copying a path onto itself creates a sibling named `name (copy).ext`, then numbered variants; allocate and publish this in the user worker with atomic no-replace semantics. Same-path moves/renames are no-ops. Copy/move/rename responses return the resulting destination path. Uploads and mkdir with unique=true allocate `name (1).ext` / `folder (1)` and further numbered siblings in the worker using atomic no-replace creation/publication, including collisions with symlinks. Return the actual path. Default explicit creation still rejects collisions. mkdir parents=true ensures an existing directory or creates missing parents; reject combining parents and unique. Upload cancellation removes only its own temporary file. Copy failures preserve sources; cross-filesystem move removes the source only after a successful copy.

Listing and stat share metadata: preserve symlink identity/link text and mark links to directories as directories so direct path navigation agrees with listed entries. Broken links remain symlinks without a directory flag.

Access times reflect each operation's filesystem snapshot. Resolving or reading a symlink can advance its access time; stat/list tests must verify those snapshots separately from stable metadata.

Launch file workers from `identity.Self` so an on-disk binary update cannot change the helper protocol of a running server.

`size` streams NDJSON progress for mixed absolute paths under the user’s credentials. Sum apparent file/symlink bytes, omit directory inode sizes, and count hard links per entry; do not follow directory symlinks. Deduplicate selected paths/subtrees. Read unsorted directory batches of 128 without file contents, yield 10 ms per 128 entries, and use best-effort nice 19/idle I/O priority on the scanning thread. Emit at most every 500 ms plus initial/final snapshots. Bound traversal depth/open directories to 128, detect ancestor inode cycles, and report unreadable/skipped entries with a partial total. Cancellation stops traversal; the server owns the hard timeout.

`terminal.go` and `terminal_archive.go` own internal terminal-history, inventory, checkpoint, closure and expiry operations under the user’s credentials. Use private `~/.local/state/tuxee/terminals/<24-hex-terminal-id>/` directories without an instance directory level. Resolve an absolute `XDG_STATE_HOME` before the home default; the client forwards it only for the server’s own UID, never another account. Settings remain in `~/.config/tuxee/settings.json`.

`meta.json` carries installation ID, name, creation directory and live/dead/closed state with `closedAt`. `input-history.json` remains an exact JSON string array: 50 entries, 64 KiB each, Unicode/multiline preserved and consecutive duplicates collapsed. Store output as uncompressed UTF-8 `normal.txt` and optional `alternate.txt`, with version 1 dimensions, capture times and active-buffer identity in `output.json`; no colors, parser state or xterm-version dependency. Bound worker archive JSON to 6 MiB, output metadata to 4 KiB and terminal records to 16 KiB and text reads to 6 MiB. Reject nonregular/symlink files and directory symlinks; use existing temporary-file/rename replacement for each file. Checkpoints are best-effort, not multi-file transactions.

Reconciliation receives live IDs from the terminal manager, marks stale records dead and deletes only matching-installation closed folders past their configured retention. Default is 168 hours, zero expires on cleanup, and the settings range is 0–876000 hours. Never delete unclosed archives; skip unknown metadata/unrelated directories and never infer liveness from stored PIDs. Closing twice must not reset expiry, and late checkpoints cannot reopen closed metadata.


# Work Guidance

Never pre-check permissions as root and then perform the operation as root. Do not follow directory symlinks during recursive copy/delete. Configuration is user-owned and replaced atomically.

# Verification

Run `go test ./internal/files -v`. Worker tests cover incomplete/cancelled uploads, collision preservation, numbered file/folder names, concurrent unique uploads, directory preparation, symlink copying and consistent stat/list metadata, same-directory duplication/naming/cancellation, and directory-into-descendant rejection. Real credential boundaries are checked by identity tests. `TUXEE_SYSTEM_TEST=1 go test ./tests` verifies cleanup of failed copies containing read-only directories as an unprivileged user; browser tests cover HTTP file operations and cancellation.

Size checks cover mixed/overlapping selections, empty directories, sparse files, symlink cycles, hard links, progress cadence, cancellation and partial permission failures.

Terminal-history/archive checks cover default/absolute/relative XDG resolution, searchable Unicode bytes, private modes, installation isolation, invalid metadata/symlinks, closure races, unchanged closure time and default/zero-hour expiry.

Trash checks cover desktop record reuse, URI encoding, name collisions, volume-relative paths, malformed metadata, failed-restore preservation, symlinks, emptying, private/sticky directory validation, XDG defaults/override, cancellation and locks. Run as a regular user too; `node tests/trash.mjs` checks real credentials and a second filesystem through HTTP/Chromium.

Run package tests as a regular user too. Fixtures that remove directory write access must restore it through `t.Cleanup` before `t.TempDir` cleanup.

## Content and archives

- Text reads use bounded, cancellable sequential reads of regular UTF-8 files, rejecting invalid encodings and binary control bytes before returning content. Each page contains at most 1 MiB and 10,000 budgeted rows, counting another row after 1,000 Unicode code points independently of browser wrapping; never split UTF-8 characters or CRLF pairs. Return exact byte offset/end/total, physical line-break count, page SHA-256 and a file version covering device/inode/size/mtime/ctime/mode. Subsequent reads check that version. Saves require explicit original page range/hash and file version; never interpret a missing range as a whole-file replacement. Validate replacement limits, actual write permission and advisory locking. Stream the complete original prefix, edited page and complete suffix into a private temporary file with bounded memory; check the complete length, sync and recheck the source version/path before atomic rename. Failure/cancellation before commit removes the temporary file and leaves the original intact. Return the resized page range/hash and new version. Preserve ownership, ordinary permissions, line endings and extended attributes/ACLs; modified files lose privilege bits/capabilities. Refuse integrity-protected files. Resolve symlinks to their target; atomic replacement changes the inode (other hard links retain old content). Saving needs parent-directory write permission and temporary disk space for the complete result. Advisory locks cannot prevent writes by programs that ignore them.
- inspect returns metadata without a stream. download supports bounded offsets/lengths for authenticated media ranges. All opens remain inside the credential-dropped worker.
- `zip-download` streams a ZIP with Go's standard archive/zip writer under the same user credentials, without staging the archive or requiring an external ZIP tool. Include selected siblings, nested/empty directories and symlinks as links; reject special files and do not follow directory symlinks. Use bounded file reads and directory batches; the ZIP writer retains entry metadata, not file bodies. Cancellation or unreadable entries fail the stream without finalizing a partial ZIP. Worker failures after the response header propagate through bounded stderr.
- Archive capabilities reflect installed tar/compressors and 7zz/7z. Create and extract in private staging directories, publish with no-replace, reject destination collisions, and remove staging on error/cancellation. Extraction uses a fresh destination, never merges into existing folders; reject escaping symlinks/special files and strip special permission bits. Use maintained native archive tools.
- Native commands receive literal filenames as arguments directly, never through a shell; disable native wildcard expansion. Archive passwords go only through stdin, not argv/environment/logs. Reject newline/NUL passwords. Bound command output, enforce cancellation/process-group cleanup and a 30-minute timeout.
- Tests cover page byte/row/Unicode/CRLF limits, binary/special-file rejection, first/middle/last page growth/shrink/deletion, repeated saves with updated ranges, stale edits outside the open page, cancellation cleanup, attributes, symlink targets, metadata-only inspection, archive round-trips/password failures, collision cleanup, literal wildcard filenames, traversal and external-symlink overwrite attempts. Browser feature tests cover the HTTP paths as a real Linux user.
- ZIP download checks cover mixed selections, dotfolders, read-only/empty directories, literal filenames, symlink preservation, invalid selections and cancellation after streaming begins. Real-system checks verify Linux permission failures, archive contents, compressed-byte progress and bounded transfer memory.

# Child DOX Index

No children.
