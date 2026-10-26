package terminal

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
	"tuxee/internal/audio"
	"tuxee/internal/desktop"
	"tuxee/internal/identity"
)

type Event struct {
	Display    *desktop.State  `json:"display,omitempty"`
	Type       string          `json:"type"`
	Data       []byte          `json:"data,omitempty"`
	Snapshot   json.RawMessage `json:"snapshot,omitempty"`
	Columns    int             `json:"columns,omitempty"`
	Rows       int             `json:"rows,omitempty"`
	Control    bool            `json:"control"`
	Message    string          `json:"message,omitempty"`
	Background string          `json:"background,omitempty"`
}

// Bytes charges live output; serialized snapshots use separate recovery admission.
func (e Event) Bytes() int {
	n := len(e.Data) + len(e.Message) + len(e.Background) + 64
	if e.Display != nil {
		for _, w := range e.Display.Windows {
			n += len(w.Title) + len(w.Icon) + 64
		}
	}
	return n
}

type Info struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Directory string `json:"directory"`
	PID       int    `json:"pid"`
	Exited    bool   `json:"exited"`
	Attached  int    `json:"attached"`
}

type Manager struct {
	Audio           audio.Manager
	mu              sync.Mutex
	closing         sync.WaitGroup
	sessions        map[string]*Session
	closed          bool
	recoveries      chan struct{}
	recoveryWaiters chan struct{}
}

type Session struct {
	Display     *desktop.Display
	mu          sync.Mutex
	manager     *Manager
	user        identity.User
	info        Info
	cmd         *exec.Cmd
	pty         *os.File
	engine      *Engine
	views       map[string]*Attachment
	controller  string
	input       chan inputFrame
	done        chan struct{}
	exited      chan struct{}
	closed      bool
	redrawTimer *time.Timer
	background  string
}

type Attachment struct {
	session         *Session
	ID              string
	Events          chan Event
	queued          int
	closed          bool
	releaseSnapshot func()
}

type inputFrame struct {
	data     []byte
	consumed chan error
}

func NewManager() *Manager {
	return &Manager{sessions: make(map[string]*Session), recoveries: make(chan struct{}, 2), recoveryWaiters: make(chan struct{}, 34)}
}
func newID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

func (m *Manager) Create(user identity.User, directory, name string, columns, rows int, command, background string) (*Session, error) {
	if !validSize(columns, rows) {
		return nil, errors.New("invalid terminal dimensions")
	}
	if directory == "" {
		directory = user.Home
	}
	if !filepath.IsAbs(directory) || strings.ContainsRune(directory, 0) {
		return nil, errors.New("working directory must be absolute")
	}
	if len(name) > 80 || len(command) > 16384 {
		return nil, errors.New("terminal name or command is too long")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, errors.New("server is stopping")
	}
	count := 0
	for _, s := range m.sessions {
		if s.user.UID == user.UID {
			count++
		}
	}
	if count >= 32 || len(m.sessions) >= 128 {
		return nil, errors.New("close unused terminals before creating another")
	}
	engine, err := NewEngine(columns, rows)
	if err != nil {
		return nil, err
	}
	if err = engine.SetBackground(background); err != nil {
		engine.Close()
		return nil, err
	}
	audioEnv, releaseAudio, err := m.Audio.Environment(user)
	if err != nil {
		engine.Close()
		return nil, err
	}
	display, err := desktop.Prepare(user)
	if err != nil {
		releaseAudio()
		engine.Close()
		return nil, err
	}
	created := false
	defer func() {
		if !created {
			display.Close()
			releaseAudio()
		}
	}()
	args := []string{"-l"}
	if command != "" {
		args = []string{"-lc", command}
	}
	// Reset only the child's mask before login profiles; keep server files private.
	args = append([]string{"-c", `umask 022; exec "$@"`, "tuxee-shell", user.Shell}, args...)
	cmd := user.Command(context.Background(), "/bin/sh", args...)
	cmd.Dir = directory
	cmd.Env = append(cmd.Env, audioEnv...)
	if display != nil {
		cmd.Env = append(cmd.Env, display.Env...)
	}
	master, slave, err := pty.Open()
	if err != nil {
		engine.Close()
		return nil, err
	}
	failed := func(err error) (*Session, error) { slave.Close(); master.Close(); engine.Close(); return nil, err }
	if err = slave.Chown(int(user.UID), int(user.GID)); err != nil {
		return failed(err)
	}
	if err = slave.Chmod(0600); err != nil {
		return failed(err)
	}
	if err = pty.Setsize(master, &pty.Winsize{Cols: uint16(columns), Rows: uint16(rows)}); err != nil {
		return failed(err)
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	cmd.SysProcAttr.Setsid = true
	cmd.SysProcAttr.Setctty = true
	cmd.SysProcAttr.Ctty = 0
	if err = cmd.Start(); err != nil {
		return failed(err)
	}
	slave.Close()
	s := &Session{Display: display, manager: m, user: user, info: Info{ID: newID(), Name: name, Directory: directory, PID: cmd.Process.Pid}, cmd: cmd, pty: master, engine: engine, views: make(map[string]*Attachment), input: make(chan inputFrame, 16), done: make(chan struct{}), exited: make(chan struct{})}
	s.background = background
	if s.info.Name == "" {
		s.info.Name = "Terminal"
	}
	m.sessions[s.info.ID] = s
	m.closing.Add(1)
	created = true
	if display != nil {
		go s.watchDisplay()
	}
	go s.readOutput()
	go s.writeInput()
	go func() {
		// Keep the PID allocated until group signaling and reaping can be serialized.
		var status unix.Siginfo
		for unix.Waitid(unix.P_PID, cmd.Process.Pid, &status, unix.WEXITED|unix.WNOWAIT, nil) == unix.EINTR {
		}
		s.mu.Lock()
		_ = cmd.Wait()
		s.info.Exited = true
		s.mu.Unlock()
		display.Close()
		releaseAudio()
		close(s.exited)
	}()
	return s, nil
}

func (m *Manager) SetBackground(user identity.User, color string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.sessions {
		if s.user.UID != user.UID {
			continue
		}
		s.mu.Lock()
		if !s.closed && s.background != color {
			if err := s.engine.SetBackground(color); err != nil {
				s.broadcastLocked(Event{Type: "error", Message: "Terminal background update failed: " + err.Error()})
			} else {
				s.background = color
				// A separate event preserves any partial application escape sequence.
				s.broadcastLocked(Event{Type: "background", Background: color})
			}
		}
		s.mu.Unlock()
	}
}

func (m *Manager) Get(user identity.User, id string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.sessions[id]
	if s == nil || s.user.UID != user.UID {
		return nil, errors.New("terminal not found")
	}
	return s, nil
}
func (m *Manager) List(user identity.User) []Info {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Info{}
	for _, s := range m.sessions {
		if s.user.UID == user.UID {
			out = append(out, s.Info())
		}
	}
	return out
}
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	values := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		values = append(values, s)
	}
	m.mu.Unlock()
	for _, s := range values {
		s.Close()
	}
	m.closing.Wait()
	m.Audio.Close()
}
func (s *Session) Info() Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	info := s.info
	info.Attached = len(s.views)
	return info
}
func (s *Session) Rename(name string) error {
	if len(name) == 0 || len(name) > 80 {
		return errors.New("name must be 1–80 characters")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.info.Name = name
	return nil
}

func (m *Manager) acquireSnapshot(ctx context.Context) (func(), error) {
	select {
	case m.recoveryWaiters <- struct{}{}:
	default:
		return nil, errors.New("terminal recovery queue is full")
	}
	select {
	case m.recoveries <- struct{}{}:
		release := sync.OnceFunc(func() { <-m.recoveries; <-m.recoveryWaiters })
		if err := ctx.Err(); err != nil {
			release()
			return nil, err
		}
		return release, nil
	case <-ctx.Done():
		<-m.recoveryWaiters
		return nil, ctx.Err()
	}
}

func (s *Session) Attach(ctx context.Context) (*Attachment, error) {
	release, err := s.manager.acquireSnapshot(ctx)
	if err != nil {
		return nil, err
	}
	attached := false
	defer func() {
		if !attached {
			release()
		}
	}()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, errors.New("terminal is closed")
	}
	if len(s.views) >= 8 {
		return nil, errors.New("too many terminal attachments")
	}
	a := &Attachment{session: s, ID: newID(), Events: make(chan Event, 512), releaseSnapshot: release}
	snapshot, err := s.engine.Capture()
	if err != nil {
		return nil, err
	}
	event := Event{Type: "snapshot", Snapshot: snapshot, Display: s.Display.State()}
	if event.Bytes() > 1<<20 {
		return nil, errors.New("terminal display metadata is too large")
	}
	s.views[a.ID] = a
	if s.controller == "" {
		s.controller = a.ID
	}
	event.Control = s.controller == a.ID
	a.queued = event.Bytes()
	a.Events <- event
	if s.info.Exited {
		s.sendLocked(a, Event{Type: "exit", Message: "Process exited"})
	}
	attached = true
	return a, nil
}

func (a *Attachment) TakeControl() error {
	s := a.session
	s.mu.Lock()
	defer s.mu.Unlock()
	if a.closed {
		return errors.New("attachment closed")
	}
	if old := s.views[s.controller]; old != nil && old != a {
		s.sendLocked(old, Event{Type: "control", Message: "Control moved to another attachment"})
	}
	s.controller = a.ID
	s.sendLocked(a, Event{Type: "control", Control: true})
	return nil
}
func (a *Attachment) Release(event Event) {
	s := a.session
	s.mu.Lock()
	defer s.mu.Unlock()
	a.queued -= event.Bytes()
	if event.Type == "snapshot" {
		a.releaseSnapshot()
	}
	if a.queued < 0 {
		a.queued = 0
	}
}
func (a *Attachment) Close() {
	s := a.session
	s.mu.Lock()
	defer s.mu.Unlock()
	a.releaseSnapshot()
	s.detachLocked(a)
}
func (s *Session) detachLocked(a *Attachment) {
	if a.closed {
		return
	}
	a.closed = true
	delete(s.views, a.ID)
	if s.controller == a.ID {
		s.controller = ""
	}
	close(a.Events)
}
func (a *Attachment) Write(ctx context.Context, data []byte) error {
	s := a.session
	s.mu.Lock()
	if a.closed || s.closed || s.info.Exited {
		s.mu.Unlock()
		return errors.New("terminal is not running")
	}
	if s.controller != a.ID {
		s.mu.Unlock()
		return errors.New("take control before sending input")
	}
	consumed := make(chan error, 1)
	err := s.enqueueInputLocked(data, consumed)
	s.mu.Unlock()
	if err != nil {
		return err
	}
	select {
	case err := <-consumed:
		return err
	case <-s.done:
		return errors.New("terminal closed")
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(10 * time.Second):
		return errors.New("input acknowledgement timed out; do not replay it")
	}
}
func (s *Session) inputLocked(data []byte) error {
	return s.enqueueInputLocked(data, nil)
}
func (s *Session) enqueueInputLocked(data []byte, consumed chan error) error {
	if len(data) == 0 || len(data) > 65536 {
		return errors.New("input is too large")
	}
	select {
	case s.input <- inputFrame{append([]byte(nil), data...), consumed}:
		return nil
	default:
		return errors.New("terminal input buffer is full")
	}
}
func validSize(cols, rows int) bool { return cols >= 2 && cols <= 500 && rows >= 1 && rows <= 200 }
func (a *Attachment) Resize(cols, rows int) error {
	if !validSize(cols, rows) {
		return errors.New("invalid terminal dimensions")
	}
	s := a.session
	s.mu.Lock()
	defer s.mu.Unlock()
	if a.closed || s.closed {
		return errors.New("attachment closed")
	}
	if s.controller != a.ID {
		return errors.New("take control before resizing")
	}
	update, err := s.engine.Apply(nil, cols, rows)
	if err != nil {
		return err
	}
	if err = pty.Setsize(s.pty, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)}); err != nil {
		return err
	}
	s.broadcastLocked(Event{Type: "resize", Columns: cols, Rows: rows})
	s.syncDisplayLocked(update)
	return nil
}
func (s *Session) sendLocked(a *Attachment, event Event) {
	if a.closed {
		return
	}
	if a.queued+event.Bytes() > 1<<20 {
		s.detachLocked(a)
		return
	}
	select {
	case a.Events <- event:
		a.queued += event.Bytes()
	default:
		s.detachLocked(a)
	}
}
func (s *Session) broadcastLocked(event Event) {
	for _, a := range s.views {
		s.sendLocked(a, event)
	}
}
func (s *Session) syncDisplayLocked(update DisplayUpdate) {
	if update.Synchronized && s.redrawTimer == nil {
		s.redrawTimer = time.AfterFunc(time.Second, func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.redrawTimer = nil
			if !s.closed {
				if next, err := s.engine.Flush(); err == nil {
					s.syncDisplayLocked(next)
				}
			}
		})
	} else if !update.Synchronized && s.redrawTimer != nil {
		s.redrawTimer.Stop()
		s.redrawTimer = nil
	}
}
func (s *Session) readOutput() {
	buffer := make([]byte, 32<<10)
	for {
		n, err := s.pty.Read(buffer)
		if n > 0 {
			s.mu.Lock()
			if s.closed {
				s.mu.Unlock()
				return
			}
			data := append([]byte(nil), buffer[:n]...)
			update, displayErr := s.engine.Apply(data, 0, 0)
			if displayErr != nil {
				s.broadcastLocked(Event{Type: "error", Message: "Terminal display failed: " + displayErr.Error()})
				s.mu.Unlock()
				s.Close()
				return
			}
			if len(update.Reply) > 0 {
				if replyErr := s.inputLocked(update.Reply); replyErr != nil {
					s.broadcastLocked(Event{Type: "error", Message: replyErr.Error()})
					s.mu.Unlock()
					s.Close()
					return
				}
			}
			s.broadcastLocked(Event{Type: "data", Data: data})
			s.syncDisplayLocked(update)
			s.mu.Unlock()
		}
		if err != nil {
			s.mu.Lock()
			if !s.closed {
				if update, err := s.engine.Flush(); err == nil {
					s.syncDisplayLocked(update)
				}
				s.broadcastLocked(Event{Type: "exit", Message: "Process exited"})
			}
			s.mu.Unlock()
			return
		}
	}
}
func (s *Session) writeInput() {
	for {
		select {
		case frame := <-s.input:
			_, err := s.pty.Write(frame.data)
			if frame.consumed != nil {
				frame.consumed <- err
			}
			if err != nil {
				return
			}
		case <-s.done:
			return
		}
	}
}

func (s *Session) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.mu.Unlock()
	s.destroy()
}
func (s *Session) destroy() {
	defer s.manager.closing.Done()
	s.manager.mu.Lock()
	delete(s.manager.sessions, s.info.ID)
	s.manager.mu.Unlock()
	s.mu.Lock()
	if s.redrawTimer != nil {
		s.redrawTimer.Stop()
	}
	for _, a := range s.views {
		s.sendLocked(a, Event{Type: "closed", Message: "Terminal closed"})
		s.detachLocked(a)
	}
	close(s.done)
	if !s.info.Exited {
		_ = syscall.Kill(-s.cmd.Process.Pid, syscall.SIGHUP)
	}
	_ = s.pty.Close()
	s.engine.Close()
	s.mu.Unlock()
	s.Display.Close()
	select {
	case <-s.exited:
	case <-time.After(time.Second):
		s.mu.Lock()
		if !s.info.Exited {
			_ = syscall.Kill(-s.cmd.Process.Pid, syscall.SIGKILL)
			_ = s.cmd.Process.Kill()
		}
		s.mu.Unlock()
		<-s.exited
	}
}

func (s *Session) String() string { return fmt.Sprintf("terminal %s", s.info.ID) }

func (s *Session) watchDisplay() {
	for {
		select {
		case <-s.done:
			return
		case <-s.exited:
			return
		case <-s.Display.Changes:
			state := s.Display.State()
			s.mu.Lock()
			if !s.closed {
				s.broadcastLocked(Event{Type: "display", Display: state})
			}
			s.mu.Unlock()
		}
	}
}
