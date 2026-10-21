package terminal

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"tuxee/internal/identity"
)

func TestDetachedPTYAndController(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("credential-switching integration requires root")
	}
	u, err := identity.Lookup("root")
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager()
	defer m.Close()
	s, err := m.Create(u, t.TempDir(), "test", 80, 24, "printf 'STARTED'; while :; do printf '.'; sleep 0.05; done")
	if err != nil {
		t.Fatal(err)
	}
	a, err := s.Attach()
	if err != nil {
		t.Fatal(err)
	}
	if first := <-a.Events; first.Type != "snapshot" || !first.Control {
		t.Fatalf("initial attach %#v", first)
	}
	b, err := s.Attach()
	if err != nil {
		t.Fatal(err)
	}
	if first := <-b.Events; first.Control {
		t.Fatal("second view stole control")
	}
	if err = b.Write([]byte("x")); err == nil {
		t.Fatal("observer input accepted")
	}
	if err = b.TakeControl(); err != nil {
		t.Fatal(err)
	}
	if err = a.Write([]byte("x")); err == nil {
		t.Fatal("old controller retained input")
	}
	pid := s.Info().PID
	a.Close()
	b.Close()
	time.Sleep(100 * time.Millisecond)
	c, err := s.Attach()
	if err != nil {
		t.Fatal(err)
	}
	first := <-c.Events
	if first.Type != "snapshot" || !strings.Contains(snapshotText(t, first.Snapshot, "normal"), "STARTED") {
		t.Fatal("lost retained display")
	}
	if s.Info().PID != pid {
		t.Fatal("reconnect replaced process")
	}
	time.Sleep(600 * time.Millisecond)
	if _, err = m.Get(u, s.info.ID); err != nil {
		t.Fatal("attached terminal expired")
	}
	c.Close()
	time.Sleep(600 * time.Millisecond)
	if info := s.Info(); info.Exited || info.Attached != 0 || info.PID != pid {
		t.Fatalf("detachment changed the running process: %#v", info)
	}
	if _, err = m.Get(u, s.info.ID); err != nil {
		t.Fatal("detached terminal disappeared")
	}
	s.Close()
	if _, err = m.Get(u, s.info.ID); err == nil {
		t.Fatal("explicitly closed terminal remains listed")
	}
}

func TestManagerCloseWaitsForClosingTerminal(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires root")
	}
	user, err := identity.Lookup("root")
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager()
	defer m.Close()
	dir := t.TempDir()
	s, err := m.Create(user, dir, "closing", 80, 24, "trap '' HUP; printf ready > ready; exec sleep 60")
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(dir + "/ready"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("terminal did not become ready")
		}
		time.Sleep(10 * time.Millisecond)
	}
	go s.Close()
	for {
		if _, err := m.Get(user, s.info.ID); err != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("terminal did not start closing")
		}
		time.Sleep(time.Millisecond)
	}
	m.Close()
	select {
	case <-s.exited:
	default:
		t.Fatal("manager returned while the closing shell was still running or unreaped")
	}
	if err := syscall.Kill(s.info.PID, 0); err != syscall.ESRCH {
		t.Fatalf("terminal process remains after manager cleanup: %v", err)
	}
}

func TestReattachEndedProcessReportsExit(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires root")
	}
	user, err := identity.Lookup("root")
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager()
	defer m.Close()
	s, err := m.Create(user, t.TempDir(), "ended", 80, 24, "printf 'DONE'")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-s.exited:
	case <-time.After(3 * time.Second):
		t.Fatal("command did not exit")
	}
	a, err := s.Attach()
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if event := <-a.Events; event.Type != "snapshot" {
		t.Fatal("missing retained display")
	}
	if event := <-a.Events; event.Type != "exit" {
		t.Fatal("ended session did not report exit")
	}
	other := exec.Command("sleep", "30")
	other.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := other.Start(); err != nil {
		t.Fatal(err)
	}
	otherExited := make(chan struct{})
	go func() { other.Wait(); close(otherExited) }()
	defer func() { other.Process.Kill(); <-otherExited }()
	// Simulate reuse of a retained, already-reaped shell's numeric PID.
	s.cmd.Process.Pid = other.Process.Pid
	s.Close()
	select {
	case <-otherExited:
		t.Fatal("closing an ended terminal signaled a reused PID")
	case <-time.After(30 * time.Millisecond):
	}
}
