package terminal

import "testing"

func TestRunningCount(t *testing.T) {
	m := NewManager()
	m.sessions = map[string]*Session{
		"attached": {views: map[string]*Attachment{"view": {}}},
		"detached": {},
		"exited":   {info: Info{Exited: true}},
		"archive":  {archiveDead: true},
		"closed":   {closed: true},
	}
	if got := m.RunningCount(); got != 2 {
		t.Fatalf("got %d running terminals; want attached and detached only", got)
	}
}
