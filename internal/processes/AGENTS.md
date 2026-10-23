Parent DOX: [internal](../AGENTS.md).

# Purpose

On-demand Linux process snapshots, explicit signalling and runtime signal-permission checks.

# Ownership

Own proc discovery, CPU/proportional-memory accounting, hierarchy, bounded ranking, stable signal targets and kernel signal-permission checks. Server owns authentication and snapshot lifetime; web owns selection and presentation.

# Local Contracts

- Run discovery, command-line reads and signals through identity.User.Command and identity.Self, never under the shared server identity. Respect proc visibility and kernel signal permissions. Never expose environment contents.
- After sampling, read command lines only for displayed individual processes in the requested RAM/CPU sort. Validate PID/start identity through an open proc directory before reading its cmdline. Read at most 4 KiB plus a truncation byte; normalize argument separators, whitespace and control characters into spaces, and return at most 250 Unicode characters including any ellipsis. Missing, unreadable, exited and zombie commands have no preview. Keep grouped identities private and do not read arguments for hidden members.
- Use two CPU-counter samples 250 ms apart. CPU uses 100% per core; aggregate each process once. Resolve inconsistent parent cycles in the shared hierarchy so displayed branches and signal targets agree. New/reused processes have unavailable CPU, not fabricated zero. Zombies have summary counts, no executable work or signal actions.
- Read `smaps_rollup` once per live process during the second scan only, through the same open proc directory and signed-in credentials. RAM is `Pss_Anon + Pss_Shmem`; expose `Pss_File` separately. Unreadable/missing proportional counters use `RssAnon + RssShmem` with `estimatedRAM`; never substitute full RSS. Missing/invalid memory counters remain null, including affected totals. Carry file PSS and RSS-estimate flags through parent/group totals and estimate flags through eligible signal-target totals; sort unavailable RAM last. Keep expensive reads out of dashboard polling. Kernel memory, unmapped tmpfs, dirty/locked files and cgroup ownership can prevent equality with the RAM widget.
- Rank sibling branches by aggregate RAM (default) or CPU before returning at most 1,000 rows including summaries. Keep container init/launcher context; reserve summary rows for remaining siblings when the row budget is reached. More than 100 live siblings become the top 99 plus one group. Zombie counts have separate non-expandable rows. Grouped and omitted descendants retain full snapshot identities and target totals; never discover additional signal targets after confirmation.
- Bound discovery to 100,000 visible processes and fail explicitly above that bound. Signal targets come only from the immutable snapshot, omit zombies and processes without signal permission, and are deduplicated. Kernel permissions and, unless explicitly allowed, protected ancestors are checked again when signalling; report per-target failures without replaying mutations.
- Validate PID/start identity through an open proc directory and signal that same stable descriptor. Never fall back to a numeric kill. Refuse PID 1, the helper and its ancestors unless `allowCore` is explicitly true for that operation. The override never bypasses kernel permissions, positive-PID validation, stable identity or zombie rejection. Only SIGTERM and SIGKILL are accepted.

The internal `check-parent-signal` worker operation uses signal zero against its live parent under the signed-in user's credentials. It checks permission without sending a signal, accepting a client PID or applying the monitor's core-selection restriction. The server uses it before an explicit Tuxee restart.

# Work Guidance

Keep scans cancellable, memory bounded and independent of dashboard metrics/file-worker queues.

# Verification

Run `go test -race ./internal/processes`; fixtures cover parsing, CPU deltas, PID reuse, ranking, aggregation, grouped target deduplication, container roots, 5,000 live siblings, 20,000 zombies, the 1,000-row cap and deep/cyclic trees. Real disposable children verify stable TERM/KILL targeting and zombie rejection. A disposable test parent verifies the helper refuses its ancestor by default and can terminate it with the core override; never signal the host PID 1 or test runner. With `TUXEE_SYSTEM_TEST=1`, marked Linux accounts verify cross-user denial and owner signalling through the real helper. `TestParentSignalPermission` checks root permission, cross-user denial and a non-root parent/child with the same UID using real credential-dropped helpers.

`TestMemoryCounters`, `TestMemoryScan` and `TestMemoryAggregation` cover PSS/RSS fallback, invalid/unavailable counters, CPU-only scans, zombie exclusion, sorting, grouped totals and target estimates. `TestMemoryPermissions` checks real same-user PSS and cross-user RSS fallback with disposable credential-dropped helpers. `TestMemorySharing` uses Python fork/mmap fixtures for anonymous sharing, shared tmpfs, separate file mappings and copy-on-write, reporting scan time and old RSS.

`go test ./internal/processes -run '^$' -bench BenchmarkProjection -benchmem` measures a 50,000-process projection. `TUXEE_PROCESS_FIXTURES` optionally writes synthetic views for the browser suite; this is test-only fixture output.

`TestCommandLines` checks bounded reads and Unicode previews, control separators, unavailable commands, stale identities, zombie/symlink rejection, requested-sort visibility and cancellation. The process browser suite verifies real credential-dropped command lines through the API and UI.

# Child DOX Index

No children.
