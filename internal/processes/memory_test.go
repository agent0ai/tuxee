package processes

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tuxee/internal/identity"
)

func TestMemoryCounters(t *testing.T) {
	for _, tc := range []struct {
		name, rollup, status string
		ram, file            int64
		estimated            bool
	}{
		{"proportional", "Pss_Anon: 12 kB\nPss_Shmem: 3 kB\nPss_File: 90 kB", "RssAnon: 100 kB\nRssShmem: 30 kB", 15 * 1024, 90 * 1024, false},
		{"zero", "Pss_Anon: 0 kB\nPss_Shmem: 0 kB\nPss_File: 0 kB", "", 0, 0, false},
		{"unreadable", "", "RssAnon: 100 kB\nRssShmem: 30 kB\nRssFile: 90 kB", 130 * 1024, -1, true},
		{"old kernel", "Pss: 20 kB", "RssAnon: 10 kB\nRssShmem: 2 kB", 12 * 1024, -1, true},
		{"missing shmem", "Pss_Anon: 20 kB", "RssAnon: 10 kB", -1, -1, false},
		{"invalid", "Pss_Anon: -1 kB\nPss_Shmem: 3 kB", "RssAnon: 4 kB\nRssShmem: 0 kB", 4 * 1024, -1, true},
		{"bad unit", "Pss_Anon: 1 MB\nPss_Shmem: 3 kB", "", -1, -1, false},
		{"overflow", "Pss_Anon: 18446744073709551615 kB\nPss_Shmem: 0 kB", "", -1, -1, false},
		{"sum overflow", "Pss_Anon: 18014398509481983 kB\nPss_Shmem: 1 kB", "", -1, -1, false},
		{"no memory counters", "", "Name: kernel-thread\n", -1, -1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			if tc.rollup != "" {
				if err := os.WriteFile(filepath.Join(root, "smaps_rollup"), []byte(tc.rollup), 0600); err != nil {
					t.Fatal(err)
				}
			}
			dir, err := os.Open(root)
			if err != nil {
				t.Fatal(err)
			}
			defer dir.Close()
			var p Process
			p.readMemory(dir, []byte(tc.status))
			checkMemory(t, p.RAM, tc.ram)
			checkMemory(t, p.FileRAM, tc.file)
			if p.EstimatedRAM != tc.estimated {
				t.Fatalf("estimate = %t", p.EstimatedRAM)
			}
		})
	}
}

func TestMemoryPermissions(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires credential dropping")
	}
	owner := identity.User{UID: 65534, GID: 65534}
	cmd := owner.Command(context.Background(), "/bin/sleep", "30")
	cmd.Dir = "/"
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	for _, uid := range []uint32{65534, 65533} {
		output, err := Run(context.Background(), identity.User{UID: uid, GID: uid}, Request{Operation: "list"})
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, p := range output.Snapshot.Processes {
			if p.PID != cmd.Process.Pid {
				continue
			}
			found = true
			if p.RAM == nil || p.EstimatedRAM != (uid != owner.UID) {
				t.Fatalf("UID %d: %+v", uid, p)
			}
			if (p.FileRAM == nil) != (uid != owner.UID) {
				t.Fatal("file PSS did not respect Linux permissions")
			}
		}
		if !found {
			t.Fatal("fixture missing from snapshot")
		}
	}
}

func TestMemorySharing(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("requires python3 for fork/mmap fixture")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "python3", "-u", "-c", `
import os, mmap, tempfile, json, sys
MiB = 1024 * 1024
anon = mmap.mmap(-1, 32*MiB, flags=mmap.MAP_PRIVATE|mmap.MAP_ANONYMOUS)
shared = mmap.mmap(-1, 16*MiB)
file = tempfile.TemporaryFile()
file.truncate(16*MiB)
mapped = mmap.mmap(file.fileno(), 16*MiB)
for region in [anon, shared, mapped]:
 for offset in range(0, len(region), 4096): region[offset] = 1
mapped.flush()
ready_r, ready_w = os.pipe()
cow_r, cow_w = os.pipe()
children = []
try:
 for i in range(4):
  pid = os.fork()
  if pid == 0:
   for region in [anon, shared, mapped]: sum(region[::4096])
   os.write(ready_w, b'1')
   if i == 0:
    os.read(cow_r, 1)
    for offset in range(0, len(anon), 4096): anon[offset] = 2
    os.write(ready_w, b'1')
   while True: __import__('time').sleep(60)
  children.append(pid)
 for _ in children: os.read(ready_r, 1)
 print(json.dumps([os.getpid()] + children))
 if sys.stdin.readline():
  os.write(cow_w, b'1')
  os.read(ready_r, 1)
  print('copied')
  sys.stdin.readline()
finally:
 for pid in children: os.kill(pid, 9)
 for pid in children: os.waitpid(pid, 0)
`)
	cmd.Cancel = func() error { return cmd.Process.Signal(os.Interrupt) }
	cmd.WaitDelay = time.Second
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		input.Close()
		if err := cmd.Wait(); err != nil {
			t.Error(err)
		}
	}()
	reader := bufio.NewReader(output)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var pids []int
	if err = json.Unmarshal(line, &pids); err != nil {
		t.Fatal(err)
	}
	var previous uint64
	for phase := 0; phase < 2; phase++ {
		if phase == 1 {
			fmt.Fprintln(input, "copy")
			if line, err := reader.ReadString('\n'); err != nil || line != "copied\n" {
				t.Fatalf("copy: %q %v", line, err)
			}
		}
		started := time.Now()
		items, err := scan(ctx, "/proc", false, true)
		if err != nil {
			t.Fatal(err)
		}
		family := Snapshot{}
		var rss uint64
		for _, p := range items {
			for _, pid := range pids {
				if p.PID != pid {
					continue
				}
				family.Processes = append(family.Processes, p)
				data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
				if err != nil {
					t.Fatal(err)
				}
				rss += *memoryKB(data, "VmRSS")
			}
		}
		if len(family.Processes) != 5 {
			t.Fatal("lost family member")
		}
		root := family.View("ram").Rows[0]
		if root.TotalRAM == nil || root.TotalFileRAM == nil || root.TotalEstimatedRAM {
			t.Fatal("PSS unavailable for owned fixture")
		}
		ram, file := *root.TotalRAM, *root.TotalFileRAM
		if phase == 0 && (ram < 48<<20 || ram > 64<<20) {
			t.Fatalf("shared memory duplicated or omitted: %d", ram)
		}
		if phase == 1 && (ram-previous < 31<<20 || ram-previous > 34<<20) {
			t.Fatalf("copy-on-write delta: %d", ram-previous)
		}
		if file < 16<<20 || file > 24<<20 {
			t.Fatalf("mapped file missing or duplicated: %d", file)
		}
		if rss < 300<<20 {
			t.Fatalf("fixture did not reproduce RSS double counting: %d", rss)
		}
		t.Logf("phase %d: RAM %.1f MiB, file PSS %.1f MiB, old RSS %.1f MiB, scan %s", phase, float64(ram)/(1<<20), float64(file)/(1<<20), float64(rss)/(1<<20), time.Since(started))
		previous = ram
	}
}

func checkMemory(t *testing.T, got *uint64, want int64) {
	t.Helper()
	if want < 0 {
		if got != nil {
			t.Fatalf("expected unavailable, got %d", *got)
		}
	} else if got == nil || *got != uint64(want) {
		t.Fatalf("memory = %v, want %d", got, want)
	}
}

func TestMemoryScan(t *testing.T) {
	root := t.TempDir()
	for pid := 1; pid <= 3; pid++ {
		dir := filepath.Join(root, fmt.Sprint(pid))
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
		fields := strings.Fields("S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 123 0 999999")
		if pid == 3 {
			fields[0] = "Z"
		}
		files := map[string]string{
			"stat":   fmt.Sprintf("%d (worker) %s", pid, strings.Join(fields, " ")),
			"status": "Uid:\t1000\t1000\t1000\t1000\nRssAnon: 40 kB\nRssShmem: 10 kB\nRssFile: 800 kB\n",
		}
		if pid != 2 {
			files["smaps_rollup"] = "Pss_Anon: 10 kB\nPss_Shmem: 2 kB\nPss_File: 300 kB\n"
		}
		for name, data := range files {
			if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, withMemory := range []bool{false, true} {
		items, err := scan(context.Background(), root, false, withMemory)
		if err != nil || len(items) != 3 {
			t.Fatalf("scan: %v %v", items, err)
		}
		for _, p := range items {
			if p.State == "Z" {
				checkMemory(t, p.RAM, 0)
				continue
			}
			if !withMemory {
				checkMemory(t, p.RAM, -1)
				continue
			}
			if p.PID == 1 {
				checkMemory(t, p.RAM, 12*1024)
				checkMemory(t, p.FileRAM, 300*1024)
			}
			if p.PID == 2 {
				checkMemory(t, p.RAM, 50*1024)
				checkMemory(t, p.FileRAM, -1)
			}
			if p.EstimatedRAM != (p.PID == 2) {
				t.Fatal("lost fallback flag")
			}
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := scan(ctx, root, false, true); err != context.Canceled {
		t.Fatalf("cancellation: %v", err)
	}
}

func TestMemoryAggregation(t *testing.T) {
	s := Snapshot{Processes: []Process{fake(1, 0, 10, 0), fake(2, 1, 20, 0), fake(3, 2, 30, 0)}}
	s.Processes[2].EstimatedRAM = true
	s.Processes[2].FileRAM = nil
	for _, row := range s.View("ram").Rows {
		if !row.TotalEstimatedRAM || !row.TargetEstimatedRAM {
			t.Fatalf("lost estimate: %+v", row)
		}
		checkMemory(t, row.TotalFileRAM, -1)
	}
	s.Processes[2].CanSignal = false
	row := s.View("ram").Rows[0]
	checkMemory(t, row.TotalRAM, 60)
	checkMemory(t, row.TargetRAM, 20)
	if row.TargetEstimatedRAM {
		t.Fatal("non-target contaminated selection")
	}
	checkMemory(t, s.Processes[0].RAM, 10)
	s.Processes[2].RAM = nil
	checkMemory(t, s.View("ram").Rows[0].TotalRAM, -1)
	for pid := 4; pid < 110; pid++ {
		s.Processes = append(s.Processes, fake(pid, 1, 1, 0))
	}
	view := s.View("ram")
	if view.Rows[1].PID != 4 {
		t.Fatal("unavailable RAM must sort last")
	}
	group := view.Rows[len(view.Rows)-1]
	if !group.Group || !group.TotalEstimatedRAM || group.TargetEstimatedRAM {
		t.Fatalf("group estimates: %+v", group)
	}
	checkMemory(t, group.TotalRAM, -1)
	checkMemory(t, group.TotalFileRAM, -1)
	checkMemory(t, group.TargetRAM, 27)
}
