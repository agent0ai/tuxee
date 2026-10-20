Parent DOX: [internal](../AGENTS.md).

# Purpose

Read-only Linux resource monitoring for the authenticated dashboard.

# Ownership

Own cached CPU, memory, swap, mounted-filesystem and network samples. HTTP admission and per-user display preferences belong to server; presentation belongs to web.

# Local Contracts

- Share one sample across callers for two seconds. CPU and network rates use counter deltas; initial/reset counters produce unavailable rates, never fabricated spikes.
- Native mode reports the host. Containers read their own cgroup v1/v2 accounting and effective visible CPU/memory limits. Never replace unavailable container accounting with host usage.
- Disk capacity is per visible local filesystem, not a sum across bind mounts or container writable-layer size. Skip remote/pseudo filesystems and file bind mounts. Inputs come from kernel mount discovery, never client-supplied paths.
- No processes, addresses, environment contents or credentials are exposed. No external service, agent, database or new dependency is required.

# Work Guidance

Use the kernel's documented interfaces: [/proc](https://docs.kernel.org/filesystems/proc.html), [cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html), [v1 memory](https://docs.kernel.org/admin-guide/cgroup-v1/memory.html), [network counters](https://docs.kernel.org/networking/statistics.html).

# Verification

Run `go test -race ./internal/monitor` for counter math, container limits, mount discovery and concurrent caching. Fixtures use temporary proc/cgroup trees; real-system checks read this environment without changing resource limits.

# Child DOX Index

No children.
