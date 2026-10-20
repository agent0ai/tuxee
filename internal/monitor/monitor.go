package monitor

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

// AllNetworks cannot collide with a Linux interface name.
const AllNetworks = "/all"

type Capacity struct {
	Total     uint64   `json:"total"`
	Used      uint64   `json:"used"`
	Available uint64   `json:"available"`
	Percent   *float64 `json:"percent"`
}
type CPU struct {
	Percent *float64 `json:"percent"`
	Cores   float64  `json:"cores"`
}
type Disk struct {
	Path   string `json:"path"`
	Device string `json:"device"`
	Type   string `json:"type"`
	*Capacity
}
type Network struct {
	Name        string   `json:"name"`
	State       string   `json:"state"`
	Received    uint64   `json:"received"`
	Sent        uint64   `json:"sent"`
	ReceiveRate *float64 `json:"receiveRate"`
	SendRate    *float64 `json:"sendRate"`
}
type Snapshot struct {
	Time     time.Time `json:"time"`
	Scope    string    `json:"scope"`
	CPU      CPU       `json:"cpu"`
	Memory   *Capacity `json:"memory"`
	Swap     *Capacity `json:"swap"`
	Disks    []Disk    `json:"disks"`
	Networks []Network `json:"networks"`
}
type cpuCounter struct {
	total, idle uint64
	usage       float64
	valid       bool
}
type Collector struct {
	mu        sync.Mutex
	root      string
	container bool
	last      *Snapshot
	cpu       cpuCounter
	statfs    func(string, *unix.Statfs_t) error
}

func New() *Collector {
	_, docker := os.Stat("/.dockerenv")
	_, podman := os.Stat("/run/.containerenv")
	groups, _ := os.ReadFile("/proc/self/cgroup")
	container := docker == nil || podman == nil || os.Getenv("container") != ""
	for _, marker := range []string{"docker", "kubepods", "libpod", "lxc"} {
		container = container || strings.Contains(string(groups), marker)
	}
	return &Collector{root: "/", container: container, statfs: unix.Statfs}
}
func (c *Collector) read(path string) (string, error) {
	data, err := os.ReadFile(filepath.Join(c.root, path))
	return string(data), err
}
func (c *Collector) Sample() *Snapshot { return c.sampleAt(time.Now()) }
func (c *Collector) sampleAt(now time.Time) *Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.last != nil && now.Sub(c.last.Time) < 2*time.Second {
		return c.last
	}
	result := &Snapshot{Time: now, Scope: "host", Disks: []Disk{}, Networks: []Network{}}
	cpuText, _ := c.read("/proc/stat")
	counter, cores := parseCPU(cpuText)
	result.CPU.Cores = cores
	memoryText, _ := c.read("/proc/meminfo")
	memory := fields(memoryText, 1024)
	if memory["MemTotal"] > 0 {
		result.Memory = capacity(memory["MemTotal"], memory["MemTotal"]-min(memory["MemTotal"], memory["MemAvailable"]), memory["MemAvailable"])
		result.Swap = capacity(memory["SwapTotal"], memory["SwapTotal"]-min(memory["SwapTotal"], memory["SwapFree"]), memory["SwapFree"])
	}
	mountsText, _ := c.read("/proc/self/mountinfo")
	mounts := parseMounts(mountsText)
	if c.container {
		result.Scope = "container"
		counter = c.containerUsage(result, mounts, memory)
	}
	if c.last != nil {
		elapsed := now.Sub(c.last.Time).Seconds()
		if counter.valid && c.cpu.valid {
			if c.container {
				if counter.usage >= c.cpu.usage && result.CPU.Cores > 0 {
					result.CPU.Percent = percent((counter.usage - c.cpu.usage) / elapsed / result.CPU.Cores * 100)
				}
			} else if counter.total > c.cpu.total && counter.idle >= c.cpu.idle {
				delta := counter.total - c.cpu.total
				result.CPU.Percent = percent(float64(delta-min(delta, counter.idle-c.cpu.idle)) / float64(delta) * 100)
			}
		}
	}
	c.disks(result, mounts)
	c.networks(result)
	c.cpu, c.last = counter, result
	return result
}
func percent(value float64) *float64 { value = math.Max(0, math.Min(100, value)); return &value }
func capacity(total, used, available uint64) *Capacity {
	value := &Capacity{Total: total, Used: min(total, used), Available: min(total, available)}
	if total > 0 {
		value.Percent = percent(float64(value.Used) / float64(total) * 100)
	}
	return value
}
func fields(data string, scale uint64) map[string]uint64 {
	out := map[string]uint64{}
	for _, line := range strings.Split(data, "\n") {
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		if value, err := strconv.ParseUint(parts[1], 10, 64); err == nil {
			out[strings.TrimSuffix(parts[0], ":")] = value * scale
		}
	}
	return out
}
func parseCPU(data string) (cpuCounter, float64) {
	var result cpuCounter
	var cores float64
	for _, line := range strings.Split(data, "\n") {
		parts := strings.Fields(line)
		if len(parts) == 0 {
			continue
		}
		if parts[0] != "cpu" {
			if strings.HasPrefix(parts[0], "cpu") {
				cores++
			}
			continue
		}
		if len(parts) < 5 {
			continue
		}
		result.valid = true
		// guest and guest_nice are already included in user and nice.
		for i := 1; i < len(parts) && i <= 8; i++ {
			value, err := strconv.ParseUint(parts[i], 10, 64)
			if err != nil {
				result.valid = false
				break
			}
			result.total += value
			if i == 4 || i == 5 {
				result.idle += value
			}
		}
	}
	return result, cores
}

type mount struct{ root, path, fs, device, options string }

func parseMounts(data string) []mount {
	result := []mount{}
	unescape := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)
	for _, line := range strings.Split(data, "\n") {
		a, b, ok := strings.Cut(line, " - ")
		before, after := strings.Fields(a), strings.Fields(b)
		if !ok || len(before) < 6 || len(after) < 3 {
			continue
		}
		result = append(result, mount{unescape.Replace(before[3]), unescape.Replace(before[4]), after[0], unescape.Replace(after[1]), after[2]})
	}
	return result
}
func (c *Collector) disks(result *Snapshot, mounts []mount) {
	seen := map[string]bool{}
	for _, item := range mounts {
		switch item.fs {
		case "ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "vfat", "exfat", "ntfs", "ntfs3", "overlay", "aufs", "tmpfs":
		default:
			continue
		}
		if item.path != "/" && (item.path == "/dev" || strings.HasPrefix(item.path, "/dev/") || item.path == "/run" || strings.HasPrefix(item.path, "/run/") || strings.HasPrefix(item.path, "/proc/") || strings.HasPrefix(item.path, "/sys/")) {
			continue
		}
		if seen[item.path] || len(result.Disks) >= 64 {
			continue
		}
		info, err := os.Stat(filepath.Join(c.root, item.path))
		if err != nil || !info.IsDir() {
			continue
		}
		seen[item.path] = true
		disk := Disk{Path: item.path, Device: item.device, Type: item.fs}
		var stat unix.Statfs_t
		if c.statfs(filepath.Join(c.root, item.path), &stat) == nil && stat.Bsize > 0 {
			block := uint64(stat.Bsize)
			disk.Capacity = capacity(stat.Blocks*block, (stat.Blocks-min(stat.Blocks, stat.Bfree))*block, stat.Bavail*block)
		}
		result.Disks = append(result.Disks, disk)
	}
	sort.Slice(result.Disks, func(i, j int) bool { return result.Disks[i].Path < result.Disks[j].Path })
}
func (c *Collector) networks(result *Snapshot) {
	text, err := c.read("/proc/net/dev")
	if err != nil {
		return
	}
	previous := map[string]Network{}
	if c.last != nil {
		for _, item := range c.last.Networks {
			previous[item.Name] = item
		}
	}
	for _, line := range strings.Split(text, "\n") {
		name, values, ok := strings.Cut(line, ":")
		name = strings.TrimSpace(name)
		parts := strings.Fields(values)
		if !ok || name == "" || len(parts) < 16 || strings.ContainsAny(name, "/\x00") {
			continue
		}
		rx, rxErr := strconv.ParseUint(parts[0], 10, 64)
		tx, txErr := strconv.ParseUint(parts[8], 10, 64)
		if rxErr != nil || txErr != nil {
			continue
		}
		state, _ := c.read("/sys/class/net/" + name + "/operstate")
		value := Network{Name: name, State: strings.TrimSpace(state), Received: rx, Sent: tx}
		if before, ok := previous[name]; ok {
			seconds := result.Time.Sub(c.last.Time).Seconds()
			if rx >= before.Received {
				rate := float64(rx-before.Received) / seconds
				value.ReceiveRate = &rate
			}
			if tx >= before.Sent {
				rate := float64(tx-before.Sent) / seconds
				value.SendRate = &rate
			}
		}
		result.Networks = append(result.Networks, value)
	}
	sort.Slice(result.Networks, func(i, j int) bool { return result.Networks[i].Name < result.Networks[j].Name })
	result.Networks = append([]Network{aggregateNetworks(result.Networks)}, result.Networks...)
}
func aggregateNetworks(networks []Network) Network {
	all := Network{Name: AllNetworks, State: "down", ReceiveRate: new(float64), SendRate: new(float64)}
	for _, network := range networks {
		if network.State != "up" && network.State != "unknown" {
			continue
		}
		all.State = "up"
		all.Received += network.Received
		all.Sent += network.Sent
		// Sum measured rates, since membership changes invalidate aggregate counter deltas.
		if network.ReceiveRate == nil {
			all.ReceiveRate = nil
		} else if all.ReceiveRate != nil {
			*all.ReceiveRate += *network.ReceiveRate
		}
		if network.SendRate == nil {
			all.SendRate = nil
		} else if all.SendRate != nil {
			*all.SendRate += *network.SendRate
		}
	}
	return all
}
func (c *Collector) number(path string) (uint64, error) {
	data, err := c.read(path)
	if err != nil {
		return 0, err
	}
	value, err := strconv.ParseUint(strings.TrimSpace(data), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid counter")
	}
	return value, nil
}
