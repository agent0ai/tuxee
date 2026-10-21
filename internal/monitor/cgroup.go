package monitor

import (
	"path/filepath"
	"strconv"
	"strings"
)

type group struct {
	path, boundary string
	v2             bool
}

func (c *Collector) group(mounts []mount, controller string) group {
	data, _ := c.read("/proc/self/cgroup")
	var unified group
	for _, line := range strings.Split(data, "\n") {
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 {
			continue
		}
		v2 := parts[0] == "0" && parts[1] == ""
		if !v2 && !contains(parts[1], controller) {
			continue
		}
		for _, m := range mounts {
			if v2 && m.fs != "cgroup2" || !v2 && (m.fs != "cgroup" || !contains(m.options, controller)) {
				continue
			}
			path := parts[2]
			if m.root != "/" && (path == m.root || strings.HasPrefix(path, m.root+"/")) {
				path = strings.TrimPrefix(path, m.root)
			}
			// Namespaced membership can already be relative to the mounted cgroup root.
			path = filepath.Join(m.path, filepath.Clean("/"+path))
			value := group{path: path, boundary: m.path, v2: v2}
			if !v2 {
				return value
			}
			unified = value
		}
	}
	return unified
}
func contains(list, value string) bool {
	for _, item := range strings.Split(list, ",") {
		if item == value {
			return true
		}
	}
	return false
}
func (g group) parents() []string {
	if g.path == "" {
		return nil
	}
	result := []string{}
	for path := g.path; ; path = filepath.Dir(path) {
		result = append(result, path)
		if path == g.boundary || path == "/" {
			return result
		}
	}
}
func cpuCount(text string) float64 {
	var count float64
	for _, part := range strings.Split(strings.TrimSpace(text), ",") {
		a, b, interval := strings.Cut(part, "-")
		low, err := strconv.Atoi(a)
		if err != nil || low < 0 {
			return 0
		}
		high := low
		if interval {
			high, err = strconv.Atoi(b)
			if err != nil || high < low {
				return 0
			}
		}
		count += float64(high - low + 1)
	}
	return count
}
func (c *Collector) containerUsage(result *Snapshot, mounts []mount, host map[string]uint64) cpuCounter {
	cpu, memory, cpuset := c.group(mounts, "cpu"), c.group(mounts, "memory"), c.group(mounts, "cpuset")
	counter := cpuCounter{}
	if cpu.path != "" {
		if cpu.v2 {
			data, err := c.read(cpu.path + "/cpu.stat")
			usage, ok := fields(data, 1)["usage_usec"]
			counter.usage = float64(usage) / 1e6
			counter.valid = err == nil && ok
		} else {
			accounting := c.group(mounts, "cpuacct")
			if accounting.path != "" {
				usage, err := c.number(accounting.path + "/cpuacct.usage")
				counter.usage = float64(usage) / 1e9
				counter.valid = err == nil
			}
		}
	}
	for _, path := range cpu.parents() {
		var quota, period float64
		if cpu.v2 {
			text, _ := c.read(path + "/cpu.max")
			parts := strings.Fields(text)
			if len(parts) == 2 {
				quota, _ = strconv.ParseFloat(parts[0], 64)
				period, _ = strconv.ParseFloat(parts[1], 64)
			}
		} else {
			q, _ := c.number(path + "/cpu.cfs_quota_us")
			p, _ := c.number(path + "/cpu.cfs_period_us")
			quota, period = float64(q), float64(p)
		}
		if quota > 0 && period > 0 {
			result.CPU.Cores = min(result.CPU.Cores, quota/period)
		}
	}
	for _, path := range cpuset.parents() {
		file := "cpuset.cpus"
		if cpuset.v2 {
			file = "cpuset.cpus.effective"
		}
		text, _ := c.read(path + "/" + file)
		if count := cpuCount(text); count > 0 {
			result.CPU.Cores = min(result.CPU.Cores, count)
		}
	}
	result.Memory, result.Swap = nil, nil
	if memory.path == "" {
		return counter
	}
	currentFile, limitFile, swapFile, swapLimit := "memory.current", "memory.max", "memory.swap.current", "memory.swap.max"
	inactiveKey, activeKey, dirtyKey, writebackKey := "inactive_file", "active_file", "file_dirty", "file_writeback"
	if !memory.v2 {
		currentFile, limitFile, swapFile, swapLimit = "memory.usage_in_bytes", "memory.limit_in_bytes", "memory.memsw.usage_in_bytes", "memory.memsw.limit_in_bytes"
		inactiveKey, activeKey, dirtyKey, writebackKey = "total_inactive_file", "total_active_file", "total_dirty", "total_writeback"
	}
	usage, err := c.number(memory.path + "/" + currentFile)
	if err != nil {
		return counter
	}
	limit := host["MemTotal"]
	swapTotal := host["SwapTotal"]
	for _, path := range memory.parents() {
		cap, capErr := c.number(path + "/" + limitFile)
		if capErr == nil {
			limit = min(limit, cap)
		}
		if swapCap, e := c.number(path + "/" + swapLimit); e == nil {
			if !memory.v2 {
				if capErr != nil {
					continue
				}
				swapCap -= min(swapCap, min(cap, host["MemTotal"]))
			}
			swapTotal = min(swapTotal, swapCap)
		}
	}
	stats, err := c.read(memory.path + "/memory.stat")
	values := fields(stats, 1)
	inactive, haveInactive := values[inactiveKey]
	active, haveActive := values[activeKey]
	if err == nil && haveInactive && haveActive {
		// File LRUs exclude shmem and unevictable pages; dirty pages still need writeback.
		cache := inactive + active
		cache -= min(cache, values[dirtyKey]+values[writebackKey])
		if memory.v2 {
			cache += values["slab_reclaimable"]
		}
		cache = min(usage, cache)
		used := usage - cache
		result.Memory = capacity(limit, used, limit-min(limit, used))
		cache = min(cache, result.Memory.Available)
		result.Memory.Cache = &cache
	}
	if swap, e := c.number(memory.path + "/" + swapFile); e == nil {
		if !memory.v2 {
			swap -= min(swap, usage)
		}
		result.Swap = capacity(swapTotal, swap, swapTotal-min(swapTotal, swap))
	}
	return counter
}
