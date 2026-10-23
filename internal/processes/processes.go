package processes

/*
#include <unistd.h>
*/
import "C"

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"golang.org/x/sys/unix"
)

const Limit = 1000
const MaxProcesses = 100000

type Ref struct {
	PID   int    `json:"pid"`
	Start string `json:"start"`
}
type Process struct {
	Ref
	Parent       int      `json:"parent"`
	Name         string   `json:"name"`
	CommandLine  string   `json:"commandLine,omitempty"`
	UID          uint32   `json:"uid"`
	State        string   `json:"state"`
	CPU          *float64 `json:"cpu"`
	RAM          *uint64  `json:"ram"`
	FileRAM      *uint64  `json:"fileRAM"`
	EstimatedRAM bool     `json:"estimatedRAM,omitempty"`
	CanSignal    bool     `json:"canSignal"`
	ticks        uint64
	sampled      time.Time
}
type Snapshot struct {
	Time      time.Time `json:"time"`
	Processes []Process `json:"processes"`
}
type Row struct {
	Process
	ID                 string   `json:"id"`
	ParentID           string   `json:"parentID"`
	TotalCPU           *float64 `json:"totalCPU"`
	TotalRAM           *uint64  `json:"totalRAM"`
	TotalFileRAM       *uint64  `json:"totalFileRAM"`
	TotalEstimatedRAM  bool     `json:"totalEstimatedRAM,omitempty"`
	Count              int      `json:"count"`
	Targets            int      `json:"targets"`
	TargetCPU          float64  `json:"targetCPU"`
	TargetRAM          *uint64  `json:"targetRAM"`
	TargetEstimatedRAM bool     `json:"targetEstimatedRAM,omitempty"`
	Group              bool     `json:"group,omitempty"`
	Zombies            int      `json:"zombies,omitempty"`
	Members            []int    `json:"-"`
	OwnTargets         int      `json:"ownTargets"`
	UnknownCPU         bool     `json:"unknownCPU,omitempty"`
}
type View struct {
	Time    time.Time `json:"time"`
	Rows    []Row     `json:"rows"`
	Total   int       `json:"total"`
	Zombies int       `json:"zombies"`
}

func readAt(dir *os.File, name string) ([]byte, error) {
	fd, err := unix.Openat(int(dir.Fd()), name, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 16385))
	if len(data) > 16384 {
		return nil, errors.New("process record too large")
	}
	return data, err
}

func readCommandLine(root string, ref Ref) string {
	dir, err := os.Open(filepath.Join(root, strconv.Itoa(ref.PID)))
	if err != nil {
		return ""
	}
	defer dir.Close()
	stat, err := readAt(dir, "stat")
	if err != nil {
		return ""
	}
	p, err := parseStat(stat)
	if err != nil || p.Ref != ref || p.State == "Z" {
		return ""
	}
	fd, err := unix.Openat(int(dir.Fd()), "cmdline", unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return ""
	}
	f := os.NewFile(uintptr(fd), "cmdline")
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil {
		return ""
	}
	truncated := len(data) > 4096
	data = data[:min(len(data), 4096)]
	words := strings.FieldsFunc(string(data), func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) })
	preview := []rune(strings.Join(words, " "))
	if len(preview) > 250 || truncated && len(preview) > 0 {
		return string(preview[:min(len(preview), 249)]) + "…"
	}
	return string(preview)
}

func (s *Snapshot) readCommandLines(ctx context.Context, root, sortBy string) error {
	// Only read arguments for displayed processes, under the worker's credentials.
	visible := make(map[Ref]bool)
	for _, row := range s.View(sortBy).Rows {
		if !row.Group && row.Zombies == 0 {
			visible[row.Ref] = true
		}
	}
	for i := range s.Processes {
		if err := ctx.Err(); err != nil {
			return err
		}
		p := &s.Processes[i]
		if visible[p.Ref] {
			p.CommandLine = readCommandLine(root, p.Ref)
		}
	}
	return nil
}

func parseStat(data []byte) (Process, error) {
	var p Process
	text := string(data)
	left, right := strings.IndexByte(text, '('), strings.LastIndexByte(text, ')')
	if left < 1 || right < left {
		return p, errors.New("invalid process stat")
	}
	pid, err := strconv.Atoi(strings.TrimSpace(text[:left]))
	if err != nil || pid <= 0 {
		return p, errors.New("invalid process ID")
	}
	fields := strings.Fields(text[right+1:])
	if len(fields) < 20 || len(fields[0]) != 1 {
		return p, errors.New("incomplete process stat")
	}
	parent, e1 := strconv.Atoi(fields[1])
	user, e2 := strconv.ParseUint(fields[11], 10, 64)
	system, e3 := strconv.ParseUint(fields[12], 10, 64)
	start, e4 := strconv.ParseUint(fields[19], 10, 64)
	if e1 != nil || e2 != nil || e3 != nil || e4 != nil || parent < 0 || parent == pid {
		return p, errors.New("invalid process counters")
	}
	p = Process{Ref: Ref{pid, strconv.FormatUint(start, 10)}, Parent: parent, Name: text[left+1 : right], State: fields[0], ticks: user + system, sampled: time.Now()}
	if p.State == "Z" {
		p.RAM = new(uint64)
		p.FileRAM = new(uint64)
		p.CPU = new(float64)
	}
	return p, nil
}
func scan(ctx context.Context, root string, allowCore, withMemory bool) ([]Process, error) {
	dir, err := os.Open(root)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	result := []Process{}
	for {
		entries, err := dir.ReadDir(256)
		if err != nil && err != io.EOF {
			return nil, err
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			pid, err := strconv.Atoi(entry.Name())
			if err != nil || pid < 1 || !entry.IsDir() {
				continue
			}
			if len(result) >= MaxProcesses {
				return nil, errors.New("too many processes to sample")
			}
			folder, err := os.Open(filepath.Join(root, entry.Name()))
			if err != nil {
				continue
			}
			stat, statErr := readAt(folder, "stat")
			status, statusErr := readAt(folder, "status")
			if statErr != nil || statusErr != nil {
				folder.Close()
				continue
			}
			p, err := parseStat(stat)
			if err != nil || p.PID != pid {
				folder.Close()
				continue
			}
			if withMemory && p.State != "Z" {
				p.readMemory(folder, status)
			}
			folder.Close()
			found := false
			for _, line := range strings.Split(string(status), "\n") {
				if !strings.HasPrefix(line, "Uid:") {
					continue
				}
				fields := strings.Fields(line)
				if len(fields) != 5 {
					break
				}
				uid, err := strconv.ParseUint(fields[2], 10, 32)
				if err != nil {
					break
				}
				p.UID = uint32(uid)
				found = true
				break
			}
			if !found {
				continue
			}
			p.CanSignal = p.State != "Z" && unix.Kill(pid, 0) == nil
			result = append(result, p)
		}
		if err == io.EOF {
			break
		}
	}
	if !allowCore {
		protectAncestors(result, os.Getpid())
	}
	return result, nil
}
func protectAncestors(items []Process, pid int) {
	byID := make(map[int]int, len(items))
	for i := range items {
		byID[items[i].PID] = i
		if items[i].PID == 1 {
			items[i].CanSignal = false
		}
	}
	seen := map[int]bool{}
	for pid > 0 && !seen[pid] {
		seen[pid] = true
		i, ok := byID[pid]
		if !ok {
			break
		}
		items[i].CanSignal = false
		pid = items[i].Parent
	}
}
func Sample(ctx context.Context, allowCore bool) (*Snapshot, error) {
	before, err := scan(ctx, "/proc", allowCore, false)
	if err != nil {
		return nil, err
	}
	timer := time.NewTimer(250 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
	}
	after, err := scan(ctx, "/proc", allowCore, true)
	if err != nil {
		return nil, err
	}
	ticks := float64(C.sysconf(C._SC_CLK_TCK))
	if ticks <= 0 {
		return nil, errors.New("CPU clock rate unavailable")
	}
	rates(before, after, ticks)
	return &Snapshot{Time: time.Now(), Processes: after}, nil
}
func rates(before, after []Process, ticks float64) {
	previous := make(map[Ref]Process, len(before))
	for _, p := range before {
		previous[p.Ref] = p
	}
	for i := range after {
		p := &after[i]
		if p.State == "Z" {
			continue
		}
		old, ok := previous[p.Ref]
		elapsed := p.sampled.Sub(old.sampled).Seconds()
		if ok && elapsed > 0 && p.ticks >= old.ticks {
			value := float64(p.ticks-old.ticks) / ticks / elapsed * 100
			p.CPU = &value
		}
	}
}

// Forest breaks transient/malformed parent cycles without recursive traversal.
func (s *Snapshot) forest() (map[int]int, [][]int, []int, []int) {
	index := make(map[int]int, len(s.Processes))
	for i, p := range s.Processes {
		index[p.PID] = i
	}
	children := make([][]int, len(s.Processes))
	roots := []int{}
	for i, p := range s.Processes {
		if parent, ok := index[p.Parent]; ok && parent != i {
			children[parent] = append(children[parent], i)
		} else {
			roots = append(roots, i)
		}
	}
	order := make([]int, 0, len(s.Processes))
	seen := make([]bool, len(s.Processes))
	walk := func(root int) {
		stack := []int{root}
		for len(stack) > 0 {
			i := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if seen[i] {
				continue
			}
			seen[i] = true
			order = append(order, i)
			stack = append(stack, children[i]...)
		}
	}
	for _, i := range roots {
		walk(i)
	}
	for i := range s.Processes {
		if !seen[i] {
			roots = append(roots, i)
			walk(i)
		}
	}
	position := make([]int, len(s.Processes))
	for n, i := range order {
		position[i] = n
	}
	for i := range children {
		valid := children[i][:0]
		for _, child := range children[i] {
			if position[child] > position[i] {
				valid = append(valid, child)
			}
		}
		children[i] = valid
	}
	return index, children, order, roots
}
func (s *Snapshot) View(sortBy string) View {
	_, children, order, roots := s.forest()
	rows := make([]Row, len(s.Processes))
	for i, p := range s.Processes {
		r := Row{Process: p, ID: fmt.Sprintf("p:%d", p.PID), TotalRAM: p.RAM, TotalFileRAM: p.FileRAM, TotalEstimatedRAM: p.EstimatedRAM, TargetRAM: new(uint64), Members: []int{p.PID}}
		if p.State != "Z" {
			r.Count = 1
		}
		if p.CPU != nil {
			value := *p.CPU
			r.TotalCPU = &value
		}
		if p.CanSignal {
			r.Targets = 1
			r.OwnTargets = 1
			r.UnknownCPU = p.CPU == nil
			r.TargetRAM = p.RAM
			r.TargetEstimatedRAM = p.EstimatedRAM
			if p.CPU != nil {
				r.TargetCPU = *p.CPU
			}
		}
		rows[i] = r
	}
	for n := len(order) - 1; n >= 0; n-- {
		i := order[n]
		for _, child := range children[i] {
			r, c := &rows[i], rows[child]
			r.TotalRAM = addMemory(r.TotalRAM, c.TotalRAM)
			r.TotalFileRAM = addMemory(r.TotalFileRAM, c.TotalFileRAM)
			r.TotalEstimatedRAM = r.TotalEstimatedRAM || c.TotalEstimatedRAM
			r.Count += c.Count
			r.Targets += c.Targets
			r.TargetRAM = addMemory(r.TargetRAM, c.TargetRAM)
			r.TargetEstimatedRAM = r.TargetEstimatedRAM || c.TargetEstimatedRAM
			r.TargetCPU += c.TargetCPU
			r.UnknownCPU = r.UnknownCPU || c.UnknownCPU
			if r.TotalCPU != nil && c.TotalCPU != nil {
				*r.TotalCPU += *c.TotalCPU
			} else {
				r.TotalCPU = nil
			}
		}
	}
	less := func(a, b int) bool {
		x, y := rows[a], rows[b]
		if sortBy == "cpu" {
			av, bv := float64(-1), float64(-1)
			if x.TotalCPU != nil {
				av = *x.TotalCPU
			}
			if y.TotalCPU != nil {
				bv = *y.TotalCPU
			}
			if av != bv {
				return av > bv
			}
		}
		if (x.TotalRAM == nil) != (y.TotalRAM == nil) {
			return x.TotalRAM != nil
		}
		if x.TotalRAM != nil && *x.TotalRAM != *y.TotalRAM {
			return *x.TotalRAM > *y.TotalRAM
		}
		return x.PID < y.PID
	}
	view := View{Time: s.Time, Rows: []Row{}, Total: len(rows)}
	for _, p := range s.Processes {
		if p.State == "Z" {
			view.Zombies++
		}
	}
	// Reserve a summary for remaining siblings before spending rows on a subtree.
	var appendBranch func([]int, string, int)
	appendBranch = func(ids []int, parent string, budget int) {
		if budget <= 0 || len(ids) == 0 {
			return
		}
		live := make([]int, 0, len(ids))
		zombies := 0
		for _, i := range ids {
			if rows[i].State == "Z" {
				zombies++
			} else {
				live = append(live, i)
			}
		}
		sort.Slice(live, func(a, b int) bool { return less(live[a], live[b]) })
		used := len(view.Rows)
		reserveZombie := 0
		if zombies > 0 {
			reserveZombie = 1
		}
		individual := len(live)
		if individual > 100 {
			individual = 99
		}
		for n, i := range live {
			remaining := budget - (len(view.Rows) - used) - reserveZombie
			if remaining <= 0 {
				break
			}
			if n >= individual || remaining == 1 && n < len(live)-1 {
				group := Row{ID: "g:" + parent, ParentID: parent, Process: Process{Name: "More processes"}, Group: true, TotalCPU: new(float64), TotalRAM: new(uint64), TotalFileRAM: new(uint64), TargetRAM: new(uint64)}
				for _, j := range live[n:] {
					r := rows[j]
					group.Members = append(group.Members, r.PID)
					group.Count += r.Count
					group.Targets += r.Targets
					group.TargetRAM = addMemory(group.TargetRAM, r.TargetRAM)
					group.TargetEstimatedRAM = group.TargetEstimatedRAM || r.TargetEstimatedRAM
					group.TargetCPU += r.TargetCPU
					group.OwnTargets += r.OwnTargets
					group.UnknownCPU = group.UnknownCPU || r.UnknownCPU
					group.TotalRAM = addMemory(group.TotalRAM, r.TotalRAM)
					group.TotalFileRAM = addMemory(group.TotalFileRAM, r.TotalFileRAM)
					group.TotalEstimatedRAM = group.TotalEstimatedRAM || r.TotalEstimatedRAM
					if group.TotalCPU != nil && r.TotalCPU != nil {
						*group.TotalCPU += *r.TotalCPU
					} else {
						group.TotalCPU = nil
					}
				}
				group.CanSignal = group.Targets > 0
				view.Rows = append(view.Rows, group)
				break
			}
			row := rows[i]
			row.ParentID = parent
			view.Rows = append(view.Rows, row)
			reserveNext := 0
			if n < len(live)-1 {
				reserveNext = 1
			}
			appendBranch(children[i], row.ID, budget-(len(view.Rows)-used)-reserveZombie-reserveNext)
		}
		if zombies > 0 && len(view.Rows)-used < budget {
			view.Rows = append(view.Rows, Row{ID: "z:" + parent, ParentID: parent, Process: Process{Name: "Zombies"}, Zombies: zombies})
		}
	}
	appendBranch(roots, "", Limit)
	return view
}

func (s *Snapshot) Targets(selected []int) ([]Ref, error) {
	if len(selected) == 0 || len(selected) > MaxProcesses {
		return nil, errors.New("invalid process selection")
	}
	index, children, _, _ := s.forest()
	stack := []int{}
	for _, pid := range selected {
		i, ok := index[pid]
		if !ok {
			return nil, errors.New("process snapshot changed; refresh")
		}
		stack = append(stack, i)
	}
	seen := map[int]bool{}
	targets := []Ref{}
	for len(stack) > 0 {
		i := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[i] {
			continue
		}
		seen[i] = true
		p := s.Processes[i]
		if p.State != "Z" && p.CanSignal {
			targets = append(targets, p.Ref)
		}
		stack = append(stack, children[i]...)
	}
	return targets, nil
}
func ValidateSignal(refs []Ref, signal int, allowCore bool) error {
	if signal != int(unix.SIGTERM) && signal != int(unix.SIGKILL) {
		return errors.New("invalid process signal")
	}
	if len(refs) == 0 || len(refs) > MaxProcesses {
		return errors.New("invalid process selection")
	}
	for _, ref := range refs {
		if ref.PID < 1 || (ref.PID == 1 && !allowCore) {
			return errors.New("protected process")
		}
		if _, err := strconv.ParseUint(ref.Start, 10, 64); err != nil {
			return errors.New("invalid process identity")
		}
	}
	return nil
}

type Result struct {
	PID   int    `json:"pid"`
	Error string `json:"error,omitempty"`
}

func Signal(ctx context.Context, refs []Ref, signal int, allowCore bool) ([]Result, error) {
	if err := ValidateSignal(refs, signal, allowCore); err != nil {
		return nil, err
	}
	if !allowCore {
		// Resolve protected ancestors independently of client data.
		protected := map[int]bool{1: true}
		pid := os.Getpid()
		for pid > 1 && !protected[pid] {
			protected[pid] = true
			data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
			if err != nil {
				return nil, err
			}
			p, err := parseStat(data)
			if err != nil {
				return nil, err
			}
			pid = p.Parent
		}
		for _, ref := range refs {
			if protected[ref.PID] {
				return nil, errors.New("selection includes Tuxee or a protected ancestor")
			}
		}
	}
	results := make([]Result, 0, len(refs))
	seen := map[Ref]bool{}
	for _, ref := range refs {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if seen[ref] {
			continue
		}
		seen[ref] = true
		err := signalOne(ref, unix.Signal(signal))
		r := Result{PID: ref.PID}
		if err != nil {
			r.Error = err.Error()
		}
		results = append(results, r)
	}
	return results, nil
}
func signalOne(ref Ref, signal unix.Signal) error {
	dir, err := os.Open(fmt.Sprintf("/proc/%d", ref.PID))
	if err != nil {
		return errors.New("process exited or is unavailable")
	}
	defer dir.Close()
	data, err := readAt(dir, "stat")
	if err != nil {
		return errors.New("process exited or is unavailable")
	}
	p, err := parseStat(data)
	if err != nil {
		return err
	}
	if p.Ref != ref {
		return errors.New("process identity changed; refresh")
	}
	if p.State == "Z" {
		return errors.New("process already exited (zombie)")
	}
	// The proc descriptor pins identity across exit/PID reuse; never signal a raw PID.
	if err := unix.PidfdSendSignal(int(dir.Fd()), signal, nil, 0); err != nil {
		return fmt.Errorf("signal not sent: %w", err)
	}
	return nil
}
