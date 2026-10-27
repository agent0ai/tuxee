package terminal

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"tuxee/internal/identity"
)

func TestShellUmask(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("credential-switching integration requires root")
	}
	previous := syscall.Umask(0077)
	defer syscall.Umask(previous)
	// Use a traversable parent even when the checkout and Go test cache are private.
	parent, err := os.MkdirTemp("", "tuxee-shell-mask-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(parent)
	if err := os.Chmod(parent, 0755); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name        string
		uid         uint32
		interactive bool
		profile     string
		mask        os.FileMode
	}{
		{name: "root-command", mask: 0022},
		{name: "root-interactive", interactive: true, mask: 0022},
		{name: "unprivileged", uid: 65534, mask: 0022},
		{name: "profile-override", uid: 65534, profile: "umask 027\n", mask: 0027},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := filepath.Join(parent, tc.name+" ' space")
			if err := os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.Chown(dir, int(tc.uid), int(tc.uid)); err != nil {
				t.Fatal(err)
			}
			if tc.profile != "" {
				if err := os.WriteFile(filepath.Join(dir, ".profile"), []byte(tc.profile), 0644); err != nil {
					t.Fatal(err)
				}
				if err := os.Chown(filepath.Join(dir, ".profile"), int(tc.uid), int(tc.uid)); err != nil {
					t.Fatal(err)
				}
			}
			user := identity.User{Name: tc.name, UID: tc.uid, GID: tc.uid, Home: dir, Shell: "/bin/sh"}
			m := NewManager()
			defer m.Close()
			command := `printf data > file; mkdir folder; sh -c 'printf child > child'; printf '%s' "$$" > pid`
			startup := command
			if tc.interactive {
				startup = ""
			}
			s, err := m.Create(user, dir, "mask", 80, 24, startup, "", "", user.Shell, false)
			if err != nil {
				t.Fatal(err)
			}
			if tc.interactive {
				a, err := s.Attach(context.Background())
				if err != nil {
					t.Fatal(err)
				}
				defer a.Close()
				if err := a.Write(context.Background(), []byte(command+"\nexit\n")); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case <-s.exited:
			case <-time.After(5 * time.Second):
				t.Fatal("shell did not finish")
			}
			for name, want := range map[string]os.FileMode{"file": 0666 &^ tc.mask, "child": 0666 &^ tc.mask, "folder": 0777 &^ tc.mask} {
				info, err := os.Stat(filepath.Join(dir, name))
				if err != nil {
					t.Fatal(err)
				}
				if info.Mode().Perm() != want || info.Sys().(*syscall.Stat_t).Uid != tc.uid {
					t.Errorf("%s: mode=%o uid=%d, want %o uid=%d", name, info.Mode().Perm(), info.Sys().(*syscall.Stat_t).Uid, want, tc.uid)
				}
			}
			pid, err := os.ReadFile(filepath.Join(dir, "pid"))
			if err != nil || string(pid) != strconv.Itoa(s.Info().PID) {
				t.Fatalf("shell PID changed: %q, %v", pid, err)
			}
		})
	}
	private := filepath.Join(parent, "server-private")
	if err := os.WriteFile(private, nil, 0666); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(private); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("server's private mask changed: %v, %v", info, err)
	}
}

func TestBackgroundUpdatesOwnedSessions(t *testing.T) {
	m := NewManager()
	owner := identity.User{UID: 1000}
	for _, id := range []string{"attached", "detached", "other"} {
		e, err := NewEngine(80, 24)
		if err != nil {
			t.Fatal(err)
		}
		defer e.Close()
		s := &Session{manager: m, user: owner, engine: e, views: make(map[string]*Attachment)}
		if id == "other" {
			s.user.UID++
		}
		m.sessions[id] = s
	}
	a, err := m.sessions["attached"].Attach(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	<-a.Events
	m.SetBackground(owner, "#123456", "")
	if event := <-a.Events; event.Type != "background" || event.Background != "#123456" {
		t.Fatalf("missing ordered background event: %+v", event)
	}
	for id, s := range m.sessions {
		update, err := s.engine.Apply([]byte("\x1b]11;?\x07"), 0, 0)
		want := "1212/3434/5656"
		if id == "other" {
			want = "1b1b/2222/3030"
		}
		if err != nil || !strings.Contains(string(update.Reply), want) {
			t.Fatalf("%s: %q, %v", id, update.Reply, err)
		}
	}
	s := m.sessions["attached"]
	if _, err := s.engine.Apply([]byte("\x1b]11;#654321\x07"), 0, 0); err != nil {
		t.Fatal(err)
	}
	m.SetBackground(owner, "#123456", "")
	if len(a.Events) != 0 {
		t.Fatal("unchanged preference must not overwrite application colors")
	}
	m.SetBackground(owner, "", "")
	if event := <-a.Events; event.Type != "background" || event.Background != "" {
		t.Fatalf("missing reset event: %+v", event)
	}

	m.SetBackground(owner, "#f8f9fc", "#1c2638")
	if event := <-a.Events; event.Type != "background" || event.Foreground != "#1c2638" || event.Background != "#f8f9fc" {
		t.Fatalf("missing theme event: %+v", event)
	}
	for id, s := range m.sessions {
		update, err := s.engine.Apply([]byte("\x1b]10;?\x07"), 0, 0)
		want := "1c1c/2626/3838"
		if id == "other" {
			want = "e6e6/eded/f3f3"
		}
		if err != nil || !strings.Contains(string(update.Reply), want) {
			t.Fatalf("%s foreground: %q %v", id, update.Reply, err)
		}
	}
}

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
	s, err := m.Create(u, t.TempDir(), "test", 80, 24, "printf 'STARTED'; while :; do printf '.'; sleep 0.05; done", "", "", "/bin/sh", false)
	if err != nil {
		t.Fatal(err)
	}
	a, err := s.Attach(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first := <-a.Events; first.Type != "snapshot" || !first.Control {
		t.Fatalf("initial attach %#v", first)
	}
	b, err := s.Attach(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first := <-b.Events; first.Control {
		t.Fatal("second view stole control")
	}
	if err = b.Write(context.Background(), []byte("x")); err == nil {
		t.Fatal("observer input accepted")
	}
	if err = b.TakeControl(); err != nil {
		t.Fatal(err)
	}
	if err = a.Write(context.Background(), []byte("x")); err == nil {
		t.Fatal("old controller retained input")
	}
	pid := s.Info().PID
	a.Close()
	b.Close()
	time.Sleep(100 * time.Millisecond)
	c, err := s.Attach(context.Background())
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
	s, err := m.Create(user, dir, "closing", 80, 24, "trap '' HUP; printf ready > ready; exec sleep 60", "", "", "/bin/sh", false)
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
	s, err := m.Create(user, t.TempDir(), "ended", 80, 24, "printf 'DONE'", "", "", "/bin/sh", false)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-s.exited:
	case <-time.After(3 * time.Second):
		t.Fatal("command did not exit")
	}
	a, err := s.Attach(context.Background())
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

func TestSnapshotAdmission(t *testing.T) {
	m := NewManager()
	first, err := m.acquireSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := m.acquireSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := m.acquireSnapshot(ctx); err != context.DeadlineExceeded {
		t.Fatal("third recovery must wait", err)
	}
	if len(m.recoveryWaiters) != 2 {
		t.Fatal("cancelled waiter retained admission")
	}
	for range 32 {
		m.recoveryWaiters <- struct{}{}
	}
	if _, err := m.acquireSnapshot(context.Background()); err == nil {
		t.Fatal("unbounded recovery waiters")
	}
	for range 32 {
		<-m.recoveryWaiters
	}
	first()
	first()
	second()
	if len(m.recoveries) != 0 || len(m.recoveryWaiters) != 0 {
		t.Fatal("snapshot permit leak")
	}
	third, err := m.acquireSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	third()
}

func TestSnapshotPermitFollowsAttachment(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("real PTY requires root")
	}
	user, err := identity.Lookup("root")
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager()
	defer m.Close()
	s, err := m.Create(user, t.TempDir(), "snapshot", 80, 24, "exec sleep 60", "", "", "/bin/sh", false)
	if err != nil {
		t.Fatal(err)
	}
	a, err := s.Attach(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := s.Attach(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := s.Attach(ctx); err != context.DeadlineExceeded {
		t.Fatal("unacknowledged recoveries must hold both permits", err)
	}
	a.Release(<-a.Events)
	c, err := s.Attach(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	b.Close()
	c.Close()
	a.Close()
	if len(m.recoveries) != 0 || len(m.recoveryWaiters) != 0 {
		t.Fatal("closed attachment leaked recovery admission")
	}
	slow, err := s.Attach(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer slow.Close()
	s.mu.Lock()
	for range 17 {
		s.sendLocked(slow, Event{Type: "data", Data: make([]byte, 65536)})
	}
	s.mu.Unlock()
	if s.Info().Attached != 0 || s.Info().Exited {
		t.Fatal("overflow must detach only the slow view")
	}
	if len(m.recoveries) != 1 {
		t.Fatal("overflow released a snapshot still owned by the transport")
	}
	slow.Close()
	if len(m.recoveries) != 0 {
		t.Fatal("closed transport leaked snapshot admission")
	}
}
