package terminal

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"testing"
	"time"
	"tuxee/internal/i18n"
	"tuxee/internal/identity"
	"tuxee/internal/keeper"
)

func TestEnginePersistentCheckpoint(t *testing.T) {
	e, err := NewEngine(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	_, err = e.Apply([]byte("shell\r\n\x1b[?1049hfullscreen\x1b[31"), 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := e.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	r, err := NewEngine(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if err = r.Restore(saved); err != nil {
		t.Fatal(err)
	}
	for _, engine := range []*Engine{e, r} {
		if _, err = engine.Apply([]byte("m red\x1b[?1049l\r\nafter"), 0, 0); err != nil {
			t.Fatal(err)
		}
	}
	a, _ := e.Capture()
	b, _ := r.Capture()
	if !bytes.Equal(a, b) {
		t.Fatal("parser/buffer continuation differs after restore")
	}
	var first, second map[string]any
	x, _ := e.call("archive")
	y, _ := r.call("archive")
	json.Unmarshal([]byte(x), &first)
	json.Unmarshal([]byte(y), &second)
	if first["text"] != second["text"] {
		t.Fatalf("archive chronology differs: %q != %q", first["text"], second["text"])
	}
}

func TestEngineCheckpointValidationMessages(t *testing.T) {
	e, err := NewEngine(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	saved, err := e.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		key  string
		edit func(map[string]any)
	}{
		{"engine.unknownStateVersion", func(s map[string]any) { s["version"] = 99 }},
		{"engine.terminalStateMustBePlainJson", func(s map[string]any) { s["archive"] = nil }},
		{"engine.invalidTerminalLine", func(s map[string]any) { s["archive"].(map[string]any)["history"] = []any{nil} }},
		{"engine.invalidTerminalCursorOrMargins", func(s map[string]any) { s["archive"].(map[string]any)["boundary"] = -1 }},
	} {
		t.Run(test.key, func(t *testing.T) {
			var value map[string]any
			if err := json.Unmarshal(saved, &value); err != nil {
				t.Fatal(err)
			}
			test.edit(value)
			data, _ := json.Marshal(value)
			message := i18n.Describe(e.Restore(data))
			if message == nil || message.Key != test.key {
				t.Fatalf("validation message: %+v", message)
			}
		})
	}
}

func TestRetainedGUIRecovery(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("credential worker")
	}
	for _, tool := range []string{"xterm", "tuxee-Xvnc", "matchbox-window-manager"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool)
		}
	}
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	u, err := identity.Lookup("root")
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager()
	m.HistoryInstance = "keeper-gui-test"
	s, err := m.Create(u, u.Home, "GUI", 80, 24, "xterm -title keeper-survival -e bash", "#000000", "#ffffff", "bash", false, "en")
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	window := func(s *Session) uint32 {
		deadline := time.Now().Add(15 * time.Second)
		for time.Now().Before(deadline) {
			state := s.Display.State()
			if state != nil && len(state.Windows) > 0 {
				return state.Windows[0].ID
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("GUI never ready: %+v", s.Display.State())
		return 0
	}
	id, pid, xid := s.Info().ID, s.Info().PID, window(s)
	manifest, err := s.keeper.Load(1, 16384)
	if err != nil {
		t.Fatal(err)
	}
	var damaged map[string]any
	if err = json.Unmarshal(manifest, &damaged); err != nil {
		t.Fatal(err)
	}
	damaged["Cookie"] = "00000000000000000000000000000000"
	bad, _ := json.Marshal(damaged)
	if err = s.keeper.Save(1, bad); err != nil {
		t.Fatal(err)
	}
	m.Detach()
	broken := NewManager()
	broken.HistoryInstance = m.HistoryInstance
	broken.PruneHistory(u)
	recoverable, err := broken.Get(u, id)
	if err != nil {
		t.Fatal("observer failure lost terminal", err)
	}
	if _, exited, e := recoverable.keeper.Job(2); e != nil || exited {
		t.Fatal("observer failure killed GUI", e)
	}
	if err = recoverable.keeper.Save(1, manifest); err != nil {
		t.Fatal(err)
	}
	broken.Detach()
	n := NewManager()
	n.HistoryInstance = m.HistoryInstance
	defer n.Close()
	n.PruneHistory(u)
	restored, err := n.Get(u, id)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Info().PID != pid || window(restored) != xid {
		t.Fatal("GUI application was replaced")
	}
	if err = restored.Display.Activate(xid); err != nil {
		t.Fatal(err)
	}
}

func TestRetainedManagerRecovery(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("credential worker")
	}
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	u, err := identity.Lookup("root")
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager()
	m.HistoryInstance = "keeper-test"
	s, err := m.Create(u, u.Home, "Retained", 80, 24, "stty -echo -icanon; printf BEFORE; cat", "#000000", "#ffffff", "bash", false, "en")
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	deadline := time.Now().Add(5 * time.Second)
	for {
		s.mu.Lock()
		offset := s.offset
		s.mu.Unlock()
		if offset > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no initial output")
		}
		time.Sleep(10 * time.Millisecond)
	}
	pid, id := s.Info().PID, s.Info().ID
	s.mu.Lock()
	initial, e := s.engine.call("archive")
	s.mu.Unlock()
	if e != nil || !bytes.Contains([]byte(initial), []byte("BEFORE")) {
		t.Fatalf("shell did not start: %s (%v)", initial, e)
	}
	m.Detach()
	check, err := keeper.Connect(u, id, m.HistoryInstance)
	if err != nil {
		t.Fatal("guardian lost on detach", err)
	}
	_, dead, err := check.Job(1)
	check.Close()
	if err != nil || dead {
		t.Fatalf("shell lost on detach: dead=%v err=%v", dead, err)
	}
	// Read the file directly: the archive API would hide a missing shutdown flush.
	disk, err := os.ReadFile(os.Getenv("XDG_STATE_HOME") + "/tuxee/terminals/" + id + "/output.txt")
	if err != nil || !bytes.Contains(disk, []byte("BEFORE")) {
		t.Errorf("detach lost the durable post-mortem: %q (%v)", disk, err)
	}
	n := NewManager()
	n.HistoryInstance = m.HistoryInstance
	defer n.Close()
	n.PruneHistory(u)
	retained, err := n.Get(u, id)
	if err != nil {
		t.Fatal(err)
	}
	if retained.Info().PID != pid {
		t.Fatal("shell replaced")
	}
	a, err := retained.Attach(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	first := <-a.Events
	a.Release(first)
	if !bytes.Contains(first.Snapshot, []byte("BEFORE")) {
		// Snapshot cells are numeric; the visual archive provides a text assertion.
		retained.mu.Lock()
		text, err := retained.engine.call("archive")
		retained.mu.Unlock()
		if err != nil || !bytes.Contains([]byte(text), []byte("BEFORE")) {
			t.Fatal("lost initial output", text, err)
		}
	}
	if err = a.Resize(103, 37); err != nil {
		t.Fatal(err)
	}
	if err = a.Write(context.Background(), []byte("AFTER")); err != nil {
		t.Fatal(err)
	}
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case event := <-a.Events:
			a.Release(event)
			if bytes.Contains(event.Data, []byte("AFTER")) {
				return
			}
		case <-timer.C:
			t.Fatal("input/output did not recover")
		}
	}
}
