package monitor

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func fixture(t *testing.T, values map[string]string, container bool) *Collector {
	t.Helper()
	c := &Collector{root: t.TempDir(), container: container, statfs: func(_ string, s *unix.Statfs_t) error {
		*s = unix.Statfs_t{Blocks: 100, Bfree: 40, Bavail: 30, Bsize: 1024}
		return nil
	}}
	put(t, c, "/proc/stat", "cpu 100 0 0 300 0 0 0 0 999 999\ncpu0 1\ncpu1 1\ncpu2 1\ncpu3 1\n")
	put(t, c, "/proc/meminfo", "MemTotal: 32768 kB\nMemAvailable: 8192 kB\nMemFree: 2048 kB\nSwapTotal: 16384 kB\nSwapFree: 8192 kB\n")
	put(t, c, "/proc/self/mountinfo", "1 0 8:1 / / rw - ext4 /dev/test rw\n")
	put(t, c, "/proc/net/dev", "eth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n")
	put(t, c, "/sys/class/net/eth0/operstate", "up\n")
	for path, data := range values {
		put(t, c, path, data)
	}
	return c
}
func put(t *testing.T, c *Collector, path, data string) {
	t.Helper()
	p := filepath.Join(c.root, path)
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
}
func wantPercent(t *testing.T, value *float64, want float64) {
	t.Helper()
	if value == nil || *value != want {
		t.Fatalf("percent %v, want %v", value, want)
	}
}
func TestHostDeltasResetAndCache(t *testing.T) {
	c := fixture(t, nil, false)
	now := time.Now()
	first := c.sampleAt(now)
	if len(first.Networks) != 2 || first.Networks[0].Name != AllNetworks || first.Networks[1].Name != "eth0" {
		t.Fatalf("network choices: %+v", first.Networks)
	}
	if first.CPU.Percent != nil || first.Networks[1].ReceiveRate != nil {
		t.Fatal("initial rates must be unavailable")
	}
	if first.Memory.Used != 24576*1024 || first.Swap.Used != 8192*1024 {
		t.Fatalf("memory: %+v %+v", first.Memory, first.Swap)
	}
	if first.Memory.Cache == nil || *first.Memory.Cache != 6144*1024 || first.Swap.Cache != nil || first.Disks[0].Cache != nil {
		t.Fatal("only RAM must expose estimated reclaimable cache")
	}
	if first.Disks[0].Used != 60*1024 || first.Disks[0].Available != 30*1024 {
		t.Fatalf("reserved disk blocks lost: %+v", first.Disks[0])
	}
	put(t, c, "/proc/stat", "cpu 150 0 0 350 0 0 0 0 9999 9999\ncpu0 1\ncpu1 1\ncpu2 1\ncpu3 1\n")
	put(t, c, "/proc/net/dev", "eth0: 1100 0 0 0 0 0 0 0 2200 0 0 0 0 0 0 0\n")
	if c.sampleAt(now.Add(time.Second)) != first {
		t.Fatal("cache did not share sample")
	}
	second := c.sampleAt(now.Add(2 * time.Second))
	wantPercent(t, second.CPU.Percent, 50)
	if *second.Networks[1].ReceiveRate != 500 || *second.Networks[1].SendRate != 1000 {
		t.Fatalf("network deltas: %+v", second.Networks[1])
	}
	put(t, c, "/proc/net/dev", "eth0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n")
	put(t, c, "/proc/stat", "cpu 1 0 0 3 0 0 0 0\ncpu0 1\n")
	reset := c.sampleAt(now.Add(4 * time.Second))
	if reset.CPU.Percent != nil || reset.Networks[1].ReceiveRate != nil || reset.Networks[1].SendRate != nil {
		t.Fatal("counter reset caused false rates")
	}
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Go(func() {
			if c.sampleAt(now.Add(4*time.Second)) != reset {
				t.Error("concurrent cache changed")
			}
		})
	}
	wg.Wait()
}
func TestAllNetworks(t *testing.T) {
	c := fixture(t, nil, false)
	now := time.Now()
	for i, step := range []struct {
		name     string
		networks []Network
		rx, tx   float64 // Negative means unavailable.
	}{
		{"first sample", []Network{
			{Name: "eth0", State: "up", Received: 100, Sent: 200},
			{Name: "lo", State: "unknown", Received: 1000, Sent: 2000},
			{Name: "wlan0", State: "down", Received: 100000, Sent: 200000},
		}, -1, -1},
		{"active sum", []Network{
			{Name: "eth0", State: "up", Received: 1100, Sent: 2200},
			{Name: "lo", State: "unknown", Received: 1400, Sent: 2800},
			{Name: "wlan0", State: "dormant", Received: 300000, Sent: 400000},
		}, 700, 1400},
		{"removed interface", []Network{
			{Name: "lo", State: "unknown", Received: 1800, Sent: 3600},
		}, 200, 400},
		{"new interface named all", []Network{
			{Name: "all", State: "up", Received: 1000000, Sent: 2000000},
			{Name: "lo", State: "unknown", Received: 2200, Sent: 4400},
		}, -1, -1},
		{"new interface measured", []Network{
			{Name: "all", State: "up", Received: 1001000, Sent: 2002000},
			{Name: "lo", State: "unknown", Received: 2600, Sent: 5200},
		}, 700, 1400},
		{"receive counter reset", []Network{
			{Name: "all", State: "up", Received: 0, Sent: 2004000},
			{Name: "lo", State: "unknown", Received: 3000, Sent: 6000},
		}, -1, 1400},
		{"no active interfaces", []Network{
			{Name: "all", State: "down", Received: 0, Sent: 2004000},
			{Name: "lo", State: "lowerlayerdown", Received: 3000, Sent: 6000},
		}, 0, 0},
		{"no interfaces", nil, 0, 0},
	} {
		t.Run(step.name, func(t *testing.T) {
			text, state := "", "down"
			var received, sent uint64
			for _, network := range step.networks {
				text += fmt.Sprintf("%s: %d 0 0 0 0 0 0 0 %d 0 0 0 0 0 0 0\n", network.Name, network.Received, network.Sent)
				put(t, c, "/sys/class/net/"+network.Name+"/operstate", network.State)
				if network.State == "up" || network.State == "unknown" {
					state = "up"
					received += network.Received
					sent += network.Sent
				}
			}
			put(t, c, "/proc/net/dev", text)
			networks := c.sampleAt(now.Add(time.Duration(i) * 2 * time.Second)).Networks
			all := networks[0]
			if len(networks) != len(step.networks)+1 || all.Name != AllNetworks || all.State != state || all.Received != received || all.Sent != sent {
				t.Fatalf("aggregate: %+v", networks)
			}
			for _, direction := range []struct {
				rate *float64
				want float64
			}{{all.ReceiveRate, step.rx}, {all.SendRate, step.tx}} {
				if direction.want < 0 {
					if direction.rate != nil {
						t.Fatalf("unavailable rate became %v", *direction.rate)
					}
				} else {
					wantPercent(t, direction.rate, direction.want)
				}
			}
		})
	}
	if err := os.Remove(filepath.Join(c.root, "/proc/net/dev")); err != nil {
		t.Fatal(err)
	}
	if networks := c.sampleAt(now.Add(time.Minute)).Networks; len(networks) != 0 {
		t.Fatalf("failed read produced healthy aggregate: %+v", networks)
	}
}
func TestCgroupV2AncestorLimitsAndNamespace(t *testing.T) {
	c := fixture(t, map[string]string{
		"/proc/self/cgroup":    "0::/child\n",
		"/proc/self/mountinfo": "1 0 0:1 /docker/container /cg rw - cgroup2 cgroup rw\n",
		"/cg/cpu.max":          "100000 100000", "/cg/child/cpu.max": "200000 100000",
		"/cg/child/cpu.stat": "usage_usec 1000000\n", "/cg/child/cpuset.cpus.effective": "0-3",
		"/cg/memory.max": "8388608", "/cg/child/memory.max": "16777216",
		"/cg/child/memory.current": "6291456", "/cg/child/memory.stat": "inactive_file 1048576\nactive_file 0\n",
		"/cg/child/memory.swap.current": "1048576", "/cg/memory.swap.max": "2097152",
	}, true)
	now := time.Now()
	first := c.sampleAt(now)
	if first.Scope != "container" || first.CPU.Cores != 1 || first.Memory.Total != 8388608 || first.Memory.Used != 5242880 || first.Swap.Total != 2097152 {
		t.Fatalf("container limits: %+v %+v %+v", first, first.Memory, first.Swap)
	}
	wantPercent(t, first.Memory.Percent, 62.5)
	put(t, c, "/cg/child/cpu.stat", "usage_usec 1500000\n")
	wantPercent(t, c.sampleAt(now.Add(2*time.Second)).CPU.Percent, 25)
	if err := os.Remove(filepath.Join(c.root, "/cg/child/memory.current")); err != nil {
		t.Fatal(err)
	}
	if c.sampleAt(now.Add(4*time.Second)).Memory != nil {
		t.Fatal("missing container counter fell back to host memory")
	}
}
func TestCgroupV1AndCpuset(t *testing.T) {
	c := fixture(t, map[string]string{
		"/proc/self/cgroup":          "0::/test\n2:cpu,cpuacct:/docker/test\n3:memory:/docker/test\n4:cpuset:/docker/test\n",
		"/proc/self/mountinfo":       "4 0 0:4 / /unified rw - cgroup2 cgroup rw\n1 0 0:1 /docker /cg/cpu rw - cgroup cgroup rw,cpu,cpuacct\n2 0 0:2 /docker /cg/memory rw - cgroup cgroup rw,memory\n3 0 0:3 /docker /cg/cpuset rw - cgroup cgroup rw,cpuset\n",
		"/cg/cpu/test/cpuacct.usage": "1000000000", "/cg/cpu/test/cpu.cfs_quota_us": "50000", "/cg/cpu/test/cpu.cfs_period_us": "100000",
		"/cg/cpuset/test/cpuset.cpus":           "1-3",
		"/cg/memory/test/memory.usage_in_bytes": "4194304", "/cg/memory/test/memory.limit_in_bytes": "8388608", "/cg/memory/test/memory.stat": "total_inactive_file 1048576\ntotal_active_file 0\n",
		"/cg/memory/test/memory.memsw.usage_in_bytes": "5242880", "/cg/memory/test/memory.memsw.limit_in_bytes": "10485760",
	}, true)
	now := time.Now()
	first := c.sampleAt(now)
	if first.CPU.Cores != .5 || first.Memory.Used != 3145728 || first.Swap.Used != 1048576 || first.Swap.Total != 2097152 {
		t.Fatalf("v1: %+v %+v %+v", first.CPU, first.Memory, first.Swap)
	}
	put(t, c, "/cg/cpu/test/cpuacct.usage", "1500000000")
	wantPercent(t, c.sampleAt(now.Add(2*time.Second)).CPU.Percent, 50)
	put(t, c, "/cg/cpu/test/cpu.cfs_quota_us", "-1")
	if got := c.sampleAt(now.Add(4 * time.Second)).CPU.Cores; got != 3 {
		t.Fatalf("cpuset: %v", got)
	}
	put(t, c, "/cg/memory/test/memory.limit_in_bytes", "9223372036854771712")
	put(t, c, "/cg/memory/test/memory.memsw.limit_in_bytes", "9223372036854771712")
	unlimited := c.sampleAt(now.Add(6 * time.Second))
	if unlimited.Memory.Total != 32768*1024 || unlimited.Swap.Total != 16384*1024 {
		t.Fatal("unlimited v1 limits must respect physical capacity")
	}
}
func TestMemoryCacheBreakdown(t *testing.T) {
	for _, tc := range []struct {
		name, stats               string
		usage, limit, used, cache uint64
	}{
		{"shared locked and dirty stay used", "inactive_file 200\nactive_file 100\nfile_dirty 20\nfile_writeback 10\nslab_reclaimable 50\nshmem 400\nunevictable 100\n", 900, 1000, 580, 320},
		{"no cache", "inactive_file 0\nactive_file 0\n", 900, 1000, 900, 0},
		{"dirty counter race", "inactive_file 20\nactive_file 10\nfile_dirty 40\n", 900, 1000, 900, 0},
		{"cache counter race", "inactive_file 800\nactive_file 800\n", 900, 1000, 0, 900},
		{"limit below usage", "inactive_file 400\nactive_file 200\n", 900, 500, 300, 200},
		{"limit below hard usage", "inactive_file 100\nactive_file 200\n", 900, 500, 500, 0},
		{"reported container", "inactive_file 317513728\nactive_file 186155008\nslab_reclaimable 35379864\n", 598831104, 1073741824, 59782504, 539048600},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := fixture(t, map[string]string{
				"/proc/meminfo":           "MemTotal: 2097152 kB\n",
				"/proc/self/cgroup":       "0::/test\n",
				"/proc/self/mountinfo":    "1 0 0:1 / /cg rw - cgroup2 cgroup rw\n",
				"/cg/test/memory.current": fmt.Sprint(tc.usage),
				"/cg/test/memory.max":     fmt.Sprint(tc.limit),
				"/cg/test/memory.stat":    tc.stats,
			}, true)
			m := c.Sample().Memory
			if m == nil || m.Used != tc.used || m.Cache == nil || *m.Cache != tc.cache || m.Available != tc.limit-tc.used {
				t.Fatalf("memory breakdown: %+v", m)
			}
			wantPercent(t, m.Percent, float64(tc.used)/float64(tc.limit)*100)
		})
	}
	t.Run("v1 hierarchical cache", func(t *testing.T) {
		c := fixture(t, map[string]string{
			"/proc/self/cgroup":              "1:memory:/test\n",
			"/proc/self/mountinfo":           "1 0 0:1 / /cg rw - cgroup cgroup rw,memory\n",
			"/cg/test/memory.usage_in_bytes": "900", "/cg/test/memory.limit_in_bytes": "1000",
			"/cg/test/memory.stat": "inactive_file 999\nactive_file 999\ntotal_inactive_file 200\ntotal_active_file 100\ntotal_dirty 20\ntotal_writeback 10\ntotal_shmem 400\ntotal_unevictable 100\n",
		}, true)
		m := c.Sample().Memory
		if m == nil || m.Used != 630 || m.Cache == nil || *m.Cache != 270 || m.Available != 370 {
			t.Fatalf("v1 breakdown: %+v", m)
		}
	})
	for _, stats := range []string{"", "inactive_file 10\n", "active_file 10\ninactive_file invalid\n"} {
		c := fixture(t, map[string]string{
			"/proc/self/cgroup": "0::/test\n", "/proc/self/mountinfo": "1 0 0:1 / /cg rw - cgroup2 cgroup rw\n",
			"/cg/test/memory.current": "900", "/cg/test/memory.max": "1000",
			"/cg/test/memory.swap.current": "0", "/cg/test/memory.swap.max": "1000",
		}, true)
		if stats != "" {
			put(t, c, "/cg/test/memory.stat", stats)
		}
		m := c.Sample()
		if m.Memory != nil || m.Swap == nil || m.Swap.Used != 0 {
			t.Fatal("missing cache accounting must make only RAM unavailable")
		}
	}
	for _, free := range []uint64{0, 9000} {
		c := fixture(t, map[string]string{"/proc/meminfo": fmt.Sprintf("MemTotal: 10000 kB\nMemAvailable: 8000 kB\nMemFree: %d kB\n", free)}, false)
		m := c.Sample().Memory
		if m.Used != 2000*1024 || *m.Cache != (8000-min(8000, free))*1024 {
			t.Fatalf("host cache bounds: %+v", m)
		}
	}
}
func TestMountEscapesAndFiltering(t *testing.T) {
	c := fixture(t, map[string]string{"/proc/self/mountinfo": "1 0 8:1 / / rw - ext4 /dev/test rw\n2 1 8:2 / /data\\040disk rw - xfs /dev/data rw\n3 1 8:2 /file /bind-file rw - ext4 /dev/data rw\n4 1 0:1 / /remote rw - nfs server:/remote rw\n5 1 0:2 / /proc rw - proc proc rw\n6 1 0:3 / /dev rw - tmpfs tmpfs rw\n", "/bind-file": "fixture"}, false)
	if err := os.Mkdir(filepath.Join(c.root, "data disk"), 0755); err != nil {
		t.Fatal(err)
	}
	disks := c.Sample().Disks
	if len(disks) != 2 || disks[1].Path != "/data disk" {
		t.Fatalf("mounts: %+v", disks)
	}
}
func TestRealEnvironment(t *testing.T) {
	c := New()
	value := c.Sample()
	if value.CPU.Cores <= 0 || value.Memory == nil || value.Memory.Total == 0 || len(value.Disks) == 0 || len(value.Networks) == 0 {
		t.Fatalf("missing real metrics: %+v", value)
	}
	for _, disk := range value.Disks {
		if disk.Capacity != nil && disk.Used > disk.Total {
			t.Fatalf("disk overflow: %+v", disk)
		}
	}
}
