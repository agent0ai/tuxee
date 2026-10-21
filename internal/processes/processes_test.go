package processes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
	"tuxee/internal/identity"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "__processes" {
		if Worker() != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}
func fake(pid, parent int, ram uint64, cpu float64) Process {
	return Process{Ref: Ref{PID: pid, Start: strconv.Itoa(pid + 1000)}, Parent: parent, Name: fmt.Sprintf("worker-%d", pid), State: "S", UID: 1000, RAM: ram, CPU: &cpu, CanSignal: pid > 1}
}
func TestStatAndRates(t *testing.T) {
	fields := make([]string, 22)
	for i := range fields {
		fields[i] = "0"
	}
	fields[0] = "S"
	fields[1] = "1"
	fields[11] = "12"
	fields[12] = "3"
	fields[19] = "98765"
	fields[21] = "10"
	p, err := parseStat([]byte("42 (odd ) ( name) " + strings.Join(fields, " ")))
	if err != nil || p.Name != "odd ) ( name" || p.PID != 42 || p.Parent != 1 || p.Start != "98765" || p.ticks != 15 || p.RAM != uint64(10*os.Getpagesize()) {
		t.Fatalf("parse: %+v %v", p, err)
	}
	for _, text := range []string{"", "1 (oops", "-1 (oops) S", "1 (a) S 1"} {
		if _, err := parseStat([]byte(text)); err == nil {
			t.Fatal("accepted invalid stat", text)
		}
	}
	before := []Process{p}
	after := []Process{p}
	after[0].sampled = p.sampled.Add(time.Second)
	after[0].ticks = 40
	rates(before, after, 100)
	if after[0].CPU == nil || *after[0].CPU != 25 {
		t.Fatal("incorrect CPU", after[0].CPU)
	}
	after[0].Start = "new"
	after[0].CPU = nil
	rates(before, after, 100)
	if after[0].CPU != nil {
		t.Fatal("PID reuse used old counters")
	}
	fields[0] = "Z"
	p, err = parseStat([]byte("42 (dead) " + strings.Join(fields, " ")))
	if err != nil || p.RAM != 0 || p.CPU == nil || *p.CPU != 0 {
		t.Fatal("zombie retained active metrics")
	}
}
func TestProjection(t *testing.T) {
	fixtures := map[string]View{}
	// Container init -> launcher, with independent jobs beneath one root.
	container := Snapshot{Time: time.Now(), Processes: []Process{fake(1, 0, 1024, 0), fake(2, 1, 4096, 0)}}
	container.Processes[1].Name = "container-start"
	for i := 0; i < 16; i++ {
		parent := 10 + i
		container.Processes = append(container.Processes, fake(parent, 2, uint64(16-i)*1<<20, float64(i)))
		for j := 0; j < 8; j++ {
			container.Processes = append(container.Processes, fake(1000+i*10+j, parent, uint64(j+1)*1<<20, float64(j)/4))
		}
	}
	fixtures["container"] = container.View("ram")
	container.Processes[0].CanSignal = true
	fixtures["containerCore"] = container.View("ram")
	wide := Snapshot{Time: time.Now(), Processes: []Process{fake(1, 0, 0, 0), fake(2, 1, 20<<20, 0)}}
	for i := 3; i < 5003; i++ {
		wide.Processes = append(wide.Processes, fake(i, 2, uint64(i)*1024, float64(i%100)/10))
	}
	fixtures["wide"] = wide.View("ram")
	fixtures["wideCPU"] = wide.View("cpu")
	if len(fixtures["wide"].Rows) != 102 {
		t.Fatalf("wide rows: %d", len(fixtures["wide"].Rows))
	}
	group := fixtures["wide"].Rows[101]
	if !group.Group || group.Count != 4901 || len(group.Members) != 4901 {
		t.Fatalf("group: %+v", group)
	}
	targets, err := wide.Targets(group.Members)
	if err != nil || len(targets) != 4901 {
		t.Fatalf("group targets: %d %v", len(targets), err)
	}
	for _, sortBy := range []string{"ram", "cpu"} {
		v := wide.View(sortBy)
		if v.Rows[2].ParentID != "p:2" {
			t.Fatal("container root hierarchy lost")
		}
		if sortBy == "ram" && v.Rows[2].PID != 5002 {
			t.Fatal("RAM ranking")
		}
		if sortBy == "cpu" && *v.Rows[2].CPU != 9.9 {
			t.Fatal("CPU ranking")
		}
	}
	zombies := Snapshot{Time: time.Now(), Processes: []Process{fake(1, 0, 0, 0), fake(2, 1, 5<<20, 0)}}
	for i := 3; i < 20003; i++ {
		p := fake(i, 2, 0, 0)
		p.State = "Z"
		p.CanSignal = false
		zombies.Processes = append(zombies.Processes, p)
	}
	fixtures["zombies"] = zombies.View("ram")
	if len(fixtures["zombies"].Rows) != 3 || fixtures["zombies"].Rows[2].Zombies != 20000 {
		t.Fatal("zombies not summarized")
	}
	many := Snapshot{Time: time.Now(), Processes: []Process{fake(1, 0, 0, 0)}}
	for i := 0; i < 99; i++ {
		pid := 2 + i
		many.Processes = append(many.Processes, fake(pid, 1, 1<<20, 0))
		for j := 0; j < 99; j++ {
			many.Processes = append(many.Processes, fake(1000+i*100+j, pid, uint64(j+1)*1024, float64(j)/10))
		}
	}
	fixtures["large"] = many.View("ram")
	if len(fixtures["large"].Rows) != Limit {
		t.Fatalf("cap: %d", len(fixtures["large"].Rows))
	}
	deep := Snapshot{Time: time.Now()}
	for i := 1; i <= 5000; i++ {
		deep.Processes = append(deep.Processes, fake(i, i-1, 1024, 1))
	}
	fixtures["deep"] = deep.View("ram")
	if len(fixtures["deep"].Rows) > Limit {
		t.Fatal("deep cap")
	}
	cyclic := Snapshot{Time: time.Now(), Processes: []Process{fake(2, 3, 1, 1), fake(3, 2, 1, 1)}}
	if len(cyclic.View("ram").Rows) != 2 {
		t.Fatal("cyclic snapshot lost rows")
	}
	leaf := cyclic.View("ram").Rows[1]
	refs, err := cyclic.Targets([]int{leaf.PID})
	if err != nil || len(refs) != 1 || refs[0] != leaf.Ref {
		t.Fatalf("cyclic selection escaped the displayed subtree: %v %v", refs, err)
	}
	for name, view := range fixtures {
		if len(view.Rows) > Limit {
			t.Fatalf("%s over cap", name)
		}
		seen := map[string]bool{}
		for _, row := range view.Rows {
			if seen[row.ID] {
				t.Fatal("duplicate row", row.ID)
			}
			if row.ParentID != "" && !seen[row.ParentID] {
				t.Fatalf("%s parent after child: %s", name, row.ID)
			}
			seen[row.ID] = true
		}
	}
	if path := os.Getenv("TUXEE_PROCESS_FIXTURES"); path != "" {
		data, err := json.Marshal(fixtures)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}
func TestAggregateAndTargets(t *testing.T) {
	s := Snapshot{Processes: []Process{fake(1, 0, 1, 1), fake(2, 1, 20, 2), fake(3, 2, 30, 3), fake(4, 2, 40, 4)}}
	v := s.View("ram")
	r := v.Rows[1]
	if r.TotalRAM != 90 || r.RAM != 20 || *r.TotalCPU != 9 || *r.CPU != 2 || r.Targets != 3 || r.TargetRAM != 90 || r.TargetCPU != 9 {
		t.Fatalf("totals: %+v", r)
	}
	refs, err := s.Targets([]int{2, 3, 4})
	if err != nil || len(refs) != 3 {
		t.Fatalf("overlapping roots: %v %v", refs, err)
	}
	s.Processes[2].CanSignal = false
	refs, err = s.Targets([]int{2})
	if err != nil || len(refs) != 2 {
		t.Fatalf("protected targets: %v %v", refs, err)
	}
	if *s.Processes[1].CPU != 2 {
		t.Fatal("view mutated snapshot counters")
	}
}
func procRef(t *testing.T, pid int) Ref {
	t.Helper()
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		t.Fatal(err)
	}
	p, err := parseStat(data)
	if err != nil {
		t.Fatal(err)
	}
	return p.Ref
}
func TestCoreProcessOptIn(t *testing.T) {
	for _, allowCore := range []bool{false, true} {
		items, err := scan(context.Background(), "/proc", allowCore)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, item := range items {
			if item.PID == os.Getpid() {
				found = true
				if item.CanSignal != allowCore {
					t.Fatalf("helper selection with allowCore=%t: %t", allowCore, item.CanSignal)
				}
			}
		}
		if !found {
			t.Fatal("helper missing from snapshot")
		}
		if err := ValidateSignal([]Ref{{PID: 1, Start: "1"}}, 15, allowCore); (err == nil) != allowCore {
			t.Fatalf("PID 1 validation with allowCore=%t: %v", allowCore, err)
		}
		for _, pid := range []int{0, -1} {
			if err := ValidateSignal([]Ref{{PID: pid, Start: "1"}}, 15, allowCore); err == nil {
				t.Fatal("accepted non-positive PID")
			}
		}
		// A stale self-reference tests the override without signalling any live core process.
		stale := procRef(t, os.Getpid())
		stale.Start += "0"
		results, err := Signal(context.Background(), []Ref{stale}, 15, allowCore)
		if !allowCore && err == nil {
			t.Fatal("accepted protected helper")
		}
		if allowCore && (err != nil || len(results) != 1 || !strings.Contains(results[0].Error, "identity changed")) {
			t.Fatalf("core override lost identity check: %v %v", results, err)
		}
	}
}
func TestCoreSignalOverride(t *testing.T) {
	if os.Getenv("TUXEE_CORE_SIGNAL_FIXTURE") == "1" {
		for _, allowCore := range []bool{false, true} {
			input, err := json.Marshal(Request{Operation: "signal", Targets: []Ref{procRef(t, os.Getpid())}, Signal: 15, AllowCore: allowCore})
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(os.Args[0], "__processes")
			cmd.Stdin = bytes.NewReader(input)
			out, err := cmd.Output()
			var response Response
			if err != nil || json.Unmarshal(out, &response) != nil {
				t.Fatalf("helper: %v", err)
			}
			if !allowCore && !strings.Contains(response.Error, "protected ancestor") {
				t.Fatalf("unprotected parent: %+v", response)
			}
		}
		t.Fatal("core override did not terminate disposable parent")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestCoreSignalOverride$")
	cmd.Env = append(os.Environ(), "TUXEE_CORE_SIGNAL_FIXTURE=1")
	out, err := cmd.CombinedOutput()
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.Sys().(syscall.WaitStatus).Signal() != syscall.SIGTERM {
		t.Fatalf("disposable parent exit: %v %s", err, out)
	}
}
func TestStableSignals(t *testing.T) {
	cmd := exec.Command("sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	ref := procRef(t, cmd.Process.Pid)
	stale := ref
	stale.Start = "0"
	if err := signalOne(stale, unix.SIGKILL); err == nil || unix.Kill(ref.PID, 0) != nil {
		t.Fatal("stale identity killed live process", err)
	}
	if _, err := Signal(context.Background(), []Ref{procRef(t, os.Getpid())}, 15, false); err == nil {
		t.Fatal("signalled helper itself")
	}
	if _, err := Signal(context.Background(), []Ref{ref}, 0, false); err == nil {
		t.Fatal("accepted arbitrary signal")
	}
	results, err := Signal(context.Background(), []Ref{ref}, 15, false)
	if err != nil || len(results) != 1 || results[0].Error != "" {
		t.Fatalf("TERM: %v %v", results, err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("TERM not delivered")
	}
	zombie := exec.Command("true")
	if err := zombie.Start(); err != nil {
		t.Fatal(err)
	}
	defer zombie.Wait()
	deadline := time.Now().Add(time.Second)
	for {
		data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", zombie.Process.Pid))
		if err != nil {
			t.Fatal(err)
		}
		p, _ := parseStat(data)
		if p.State == "Z" {
			if err := signalOne(p.Ref, unix.SIGKILL); err == nil {
				t.Fatal("zombie reported killed")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("zombie fixture timeout")
		}
		time.Sleep(time.Millisecond)
	}
}
func TestUserSignalPermissions(t *testing.T) {
	if os.Geteuid() != 0 || os.Getenv("TUXEE_SYSTEM_TEST") != "1" {
		t.Skip("requires dedicated Linux accounts")
	}
	for _, name := range []string{"tuxee-poc-a", "tuxee-poc-b"} {
		u, err := user.Lookup(name)
		if err != nil || u.Name != "Tuxee prototype test" {
			t.Skip("marked test accounts unavailable")
		}
	}
	owner, err := identity.Lookup("tuxee-poc-a")
	if err != nil {
		t.Fatal(err)
	}
	other, err := identity.Lookup("tuxee-poc-b")
	if err != nil {
		t.Fatal(err)
	}
	cmd := owner.Command(context.Background(), "/bin/sleep", "60")
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	ref := procRef(t, cmd.Process.Pid)
	for _, allowCore := range []bool{false, true} {
		denied, err := Run(context.Background(), other, Request{Operation: "signal", Targets: []Ref{ref}, Signal: 9, AllowCore: allowCore})
		if err != nil || len(denied.Results) != 1 || denied.Results[0].Error == "" || unix.Kill(ref.PID, 0) != nil {
			t.Fatalf("cross-user signal with allowCore=%t: %+v %v", allowCore, denied, err)
		}
	}
	allowed, err := Run(context.Background(), owner, Request{Operation: "signal", Targets: []Ref{ref}, Signal: 9})
	if err != nil || len(allowed.Results) != 1 || allowed.Results[0].Error != "" {
		t.Fatalf("owner signal: %+v %v", allowed, err)
	}
}
func BenchmarkProjection(b *testing.B) {
	s := Snapshot{Processes: []Process{fake(1, 0, 0, 0)}}
	for i := 2; i <= 50000; i++ {
		s.Processes = append(s.Processes, fake(i, 1, uint64(i), float64(i%10)))
	}
	b.ResetTimer()
	for b.Loop() {
		s.View("ram")
	}
}
