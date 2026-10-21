Parent DOX: [internal](../AGENTS.md).

# Purpose

Read-only Linux resource monitoring for the authenticated dashboard.

# Ownership

Own cached CPU, memory, swap, mounted-filesystem and network samples. HTTP admission and per-user display preferences belong to server; presentation belongs to web.

# Local Contracts

- Share one sample across callers for two seconds. CPU and network rates use counter deltas; initial/reset counters produce unavailable rates, never fabricated spikes.
- Return the reserved `/all` network first, summing counters and measured rates of interfaces whose operstate is `up` or `unknown`, including loopback and virtual interfaces. Sum per-interface rates, never deltas of changing aggregate counters; an unavailable member rate makes that direction unavailable. No active interfaces yield zero; a failed counter read yields no networks. Do not truncate discovery before aggregating.
- Native mode reports the host. Containers read their own cgroup v1/v2 accounting and effective visible CPU/memory limits. Never replace unavailable container accounting with host usage.
- Disk capacity is per visible local filesystem, not a sum across bind mounts or container writable-layer size. Skip remote/pseudo filesystems and file bind mounts. Inputs come from kernel mount discovery, never client-supplied paths.
- This collector exposes no processes, addresses, environment contents or credentials. On-demand process discovery/control belongs to `internal/processes`, separately from cached metrics. No external service, agent, database or new dependency is required.

# Work Guidance

Use the kernel's documented interfaces: [/proc](https://docs.kernel.org/filesystems/proc.html), [cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html), [v1 memory](https://docs.kernel.org/admin-guide/cgroup-v1/memory.html), [network counters](https://docs.kernel.org/networking/statistics.html), [operational states](https://docs.kernel.org/networking/operstates.html).

# Verification

Run `go test -race ./internal/monitor` for counter math, active-network aggregation (including membership changes and counter resets), container limits, mount discovery and concurrent caching. Fixtures use temporary proc/cgroup trees; real-system checks read this environment without changing resource limits.

# Child DOX Index

No children.
