Parent DOX: [internal](../AGENTS.md).

# Purpose

On-demand Linux process snapshots and explicit signalling for the Resource monitor.

# Ownership

Own proc discovery, CPU/RSS accounting, hierarchy, bounded ranking and stable signal targets. Server owns authentication and snapshot lifetime; web owns selection and presentation.

# Local Contracts

- Run discovery and signals through identity.User.Command and identity.Self, never under the shared server identity. Respect proc visibility and kernel signal permissions. Never expose arguments or environment contents.
- Use two CPU-counter samples 250 ms apart and inexpensive RSS. CPU uses 100% per core; aggregate each process once. Resolve inconsistent parent cycles in the shared hierarchy so displayed branches and signal targets agree. New/reused processes have unavailable CPU, not fabricated zero. Zombies have summary counts, no executable work or signal actions.
- Rank sibling branches by aggregate RAM (default) or CPU before returning at most 1,000 rows including summaries. Keep container init/launcher context; reserve summary rows for remaining siblings when the row budget is reached. More than 100 live siblings become the top 99 plus one group. Zombie counts have separate non-expandable rows. Grouped and omitted descendants retain full snapshot identities and target totals; never discover additional signal targets after confirmation.
- Bound discovery to 100,000 visible processes and fail explicitly above that bound. Signal targets come only from the immutable snapshot, omit zombies and processes without signal permission, and are deduplicated. Kernel permissions and, unless explicitly allowed, protected ancestors are checked again when signalling; report per-target failures without replaying mutations.
- Validate PID/start identity through an open proc directory and signal that same stable descriptor. Never fall back to a numeric kill. Refuse PID 1, the helper and its ancestors unless `allowCore` is explicitly true for that operation. The override never bypasses kernel permissions, positive-PID validation, stable identity or zombie rejection. Only SIGTERM and SIGKILL are accepted.

# Work Guidance

Keep scans cancellable, memory bounded and independent of dashboard metrics/file-worker queues.

# Verification

Run `go test -race ./internal/processes`; fixtures cover parsing, CPU deltas, PID reuse, ranking, aggregation, grouped target deduplication, container roots, 5,000 live siblings, 20,000 zombies, the 1,000-row cap and deep/cyclic trees. Real disposable children verify stable TERM/KILL targeting and zombie rejection. A disposable test parent verifies the helper refuses its ancestor by default and can terminate it with the core override; never signal the host PID 1 or test runner. With `TUXEE_SYSTEM_TEST=1`, marked Linux accounts verify cross-user denial and owner signalling through the real helper.

`go test ./internal/processes -run '^$' -bench BenchmarkProjection -benchmem` measures a 50,000-process projection. `TUXEE_PROCESS_FIXTURES` optionally writes synthetic views for the browser suite; this is test-only fixture output.

# Child DOX Index

No children.
