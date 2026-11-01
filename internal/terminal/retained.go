package terminal

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"golang.org/x/sys/unix"
	"io"
	"log"
	"strings"
	"time"
	"tuxee/internal/desktop"
	"tuxee/internal/files"
	"tuxee/internal/i18n"
	"tuxee/internal/identity"
	"tuxee/internal/keeper"
)

const backgroundRecord = 4
const usedRecord = 5
const sampleRecord = 6
const flushRecord = 7

type retainedState struct {
	Version        int             `json:"version"`
	Info           Info            `json:"info"`
	Background     string          `json:"background"`
	Foreground     string          `json:"foreground"`
	Used           bool            `json:"used"`
	Engine         json.RawMessage `json:"engine"`
	ShellDirectory string          `json:"shellDirectory,omitempty"`
}

// The guardian swaps the sealed snapshot and journal cursor in one operation.
func (s *Session) retainLocked() error {
	state, err := s.engine.Checkpoint()
	if err != nil {
		return err
	}
	data, err := json.Marshal(retainedState{Version: 1, Info: s.info, Background: s.background, Foreground: s.foreground, Used: s.used, Engine: state, ShellDirectory: s.shellDirectory})
	if err == nil {
		err = s.keeper.Commit(s.offset, data)
	}
	if err == nil {
		s.committed = s.offset
	}
	return err
}

func (s *Session) applyRetainedLocked(record keeper.Record) error {
	var update DisplayUpdate
	var err error
	switch record.Kind {
	case keeper.Output:
		update, err = s.engine.Apply(record.Data, 0, 0)
		if err == nil && len(update.Reply) > 0 {
			err = s.keeper.Input(update.Reply, record.Offset)
		}
		if err == nil {
			s.broadcastLocked(Event{Type: "data", Data: record.Data})
		}
	case keeper.Resize:
		if len(record.Data) != 4 {
			return fmt.Errorf("invalid retained resize")
		}
		size := binary.BigEndian.Uint32(record.Data)
		cols, rows := int(size>>16), int(size&65535)
		if !validSize(cols, rows) {
			return fmt.Errorf("invalid retained dimensions")
		}
		update, err = s.engine.Apply(nil, cols, rows)
		if err == nil {
			s.broadcastLocked(Event{Type: "resize", Columns: cols, Rows: rows})
		}
	case backgroundRecord:
		var colors [2]string
		if err = json.Unmarshal(record.Data, &colors); err == nil {
			err = s.engine.SetBackground(colors[0], colors[1])
		}
		if err == nil {
			s.background, s.foreground = colors[0], colors[1]
			s.broadcastLocked(Event{Type: "background", Background: colors[0], Foreground: colors[1]})
		}
	case usedRecord:
		s.used = true
	case sampleRecord:
		_, err = s.engine.call("sampleArchive")
	case flushRecord:
		update, err = s.engine.Flush()
	case keeper.End:
		update, err = s.engine.Flush()
		s.archiveDead = true
		s.broadcastLocked(Event{Type: "exit", Message: i18n.New("terminal.exited").Error(), Text: i18n.Describe(i18n.New("terminal.exited"))})
	default:
		return fmt.Errorf("unknown retained terminal record %d", record.Kind)
	}
	if err != nil {
		return err
	}
	s.offset = record.Offset
	s.archiveDirty = true
	s.syncDisplayLocked(update)
	if s.offset-s.committed >= 1<<20 {
		if err = s.retainLocked(); err != nil {
			return err
		}
	}
	if record.Kind == keeper.End {
		return io.EOF
	}
	return nil
}

func (s *Session) retainedEventLocked(kind uint32, data []byte) error {
	target, err := s.keeper.Event(kind, data)
	if err != nil {
		return err
	}
	for s.offset < target {
		record, err := s.keeper.Read(s.offset)
		if err != nil {
			return err
		}
		if record.Kind == 0 {
			return fmt.Errorf("missing retained event")
		}
		if err = s.applyRetainedLocked(record); err != nil {
			return err
		}
	}
	return nil
}

func (s *Session) readRetained() {
	for {
		wake := s.keeper.Changed()
		s.mu.Lock()
		if s.closed || s.detached {
			s.mu.Unlock()
			return
		}
		record, err := s.keeper.Read(s.offset)
		if err == nil && record.Kind != 0 {
			err = s.applyRetainedLocked(record)
		}
		if err != nil && err != io.EOF {
			log.Printf("retained terminal %s: %v", s.info.ID, err)
			s.broadcastLocked(Event{Type: "error", Message: err.Error(), Text: i18n.Describe(err)})
		}
		s.mu.Unlock()
		if err != nil {
			s.close(false)
			return
		}
		if record.Kind == 0 {
			select {
			case <-wake:
			case <-s.done:
				return
			}
		}
	}
}

// Discovery uses the existing metadata directories before archive reconciliation.
func (m *Manager) adoptLocked(user identity.User) {
	if m.closed || m.HistoryInstance == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	response, err := files.Run(ctx, user, files.Request{Operation: "terminal-keepers", Instance: m.HistoryInstance})
	if err != nil {
		log.Printf("terminal keeper discovery uid %d: %v", user.UID, err)
		return
	}
	for _, record := range response.Terminals {
		if m.sessions[record.ID] != nil || record.State == "closed" {
			continue
		}
		client, err := keeper.Connect(user, record.ID, m.HistoryInstance)
		if err != nil {
			log.Printf("terminal keeper attach %s: %v", record.ID, err)
			continue
		}
		if err = m.adoptSessionLocked(user, record, client); err != nil {
			client.Close()
			log.Printf("terminal keeper recovery %s: %v", record.ID, err)
		}
	}
}

func (m *Manager) adoptSessionLocked(user identity.User, record files.TerminalRecord, client *keeper.Client) error {
	job, _, jobErr := client.Job(1)
	if jobErr == unix.ENOENT {
		if display, err := desktop.Restore(user, client); err == nil {
			display.Close()
		}
		client.Stop()
		return fmt.Errorf("terminal creation did not reach process start")
	}
	if jobErr != nil {
		return jobErr
	}
	data, err := client.Load(0, MaxSnapshotBytes+16384)
	if err != nil {
		return fmt.Errorf("checkpoint: %w", err)
	}
	var state retainedState
	if err = json.Unmarshal(data, &state); err != nil {
		return err
	}
	if state.Version != 1 || state.Info.ID != record.ID {
		return fmt.Errorf("unsupported retained session checkpoint")
	}
	engine, err := NewEngine(80, 24)
	if err != nil {
		return err
	}
	if err = engine.Restore(state.Engine); err != nil {
		engine.Close()
		return err
	}
	display, err := desktop.Restore(user, client)
	if err != nil {
		engine.Close()
		return fmt.Errorf("display: %w", err)
	}
	_, releaseAudio, err := m.Audio.EnvironmentFor(user, m.HistoryInstance)
	if err != nil {
		display.Detach()
		engine.Close()
		return fmt.Errorf("audio: %w", err)
	}
	s := &Session{manager: m, user: user, info: state.Info, engine: engine, keeper: client, job: job, offset: client.Head, committed: client.Head, background: state.Background, foreground: state.Foreground, used: state.Used, views: map[string]*Attachment{}, input: make(chan inputFrame, 16), done: make(chan struct{}), exited: make(chan struct{}), readDone: make(chan struct{}), releaseShell: func() {}, releaseAudio: func() {}}
	s.info.PID = job.PID
	s.Display = display
	s.releaseAudio = releaseAudio
	s.shellDirectory = state.ShellDirectory
	s.releaseShell = func() {
		if strings.HasPrefix(state.ShellDirectory, "/tmp/tuxee-shell-") && !strings.Contains(state.ShellDirectory[5:], "/") {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, err := files.Run(ctx, user, files.Request{Operation: "delete", Path: state.ShellDirectory}); err != nil {
				log.Printf("terminal prompt cleanup %s: %v", record.ID, err)
			}
		}
	}
	s.info.Name = record.Name
	s.info.Attached = 0
	m.sessions[record.ID] = s
	m.closing.Add(1)
	go s.readOutput()
	go s.writeInput()
	go s.watchArchive()
	if display != nil {
		go s.watchDisplay()
	}
	go func() {
		_ = job.Wait()
		s.mu.Lock()
		detached := s.detached
		if !detached {
			s.info.Exited = true
			if s.info.TerminatedAt == nil {
				now := time.Now().UTC()
				s.info.TerminatedAt = &now
			}
		}
		s.mu.Unlock()
		if !detached {
			s.Display.Close()
			s.releaseAudio()
			s.releaseShell()
		}
		close(s.exited)
	}()
	return nil
}

// Detach is used for a server restart. Explicit session Close remains destructive.
func (m *Manager) Detach() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	if m.archiveStop != nil {
		close(m.archiveStop)
	}
	values := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		values = append(values, s)
	}
	m.mu.Unlock()
	for _, s := range values {
		if s.keeper == nil {
			s.close(false)
			continue
		}
		m.mu.Lock()
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			m.mu.Unlock()
			continue
		}
		if err := s.retainLocked(); err != nil {
			log.Printf("terminal detach checkpoint %s: %v", s.info.ID, err)
		}
		s.detached = true
		if s.redrawTimer != nil {
			s.redrawTimer.Stop()
		}
		for _, a := range s.views {
			s.detachLocked(a)
		}
		close(s.done)
		s.mu.Unlock()
		// Container shutdown also loses the guardian's in-memory checkpoint.
		s.checkpointLocked()
		m.mu.Unlock()
		s.Display.Detach()
		s.keeper.Close()
		<-s.readDone
		<-s.exited
		s.engine.Close()
		m.closing.Done()
	}
	m.closing.Wait()
	if m.archiveStopped != nil {
		<-m.archiveStopped
	}
	m.Audio.Detach()
}
