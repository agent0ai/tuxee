package terminal

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"
	"tuxee/internal/files"
	"tuxee/internal/identity"
)

func (s *Session) archiveRecordLocked() files.TerminalRecord {
	state := "live"
	if s.info.Exited || s.archiveDead || s.closed {
		state = "dead"
	}
	return files.TerminalRecord{ID: s.info.ID, Name: s.info.Name, Directory: s.info.Directory, State: state}
}

// The manager lock orders checkpoints, input history and explicit closure.
// Never hold the output lock during filesystem I/O.
func (s *Session) checkpointLocked() {
	if s.manager.HistoryInstance == "" {
		return
	}
	s.mu.Lock()
	record := s.archiveRecordLocked()
	data, err := s.engine.call("archive")
	s.mu.Unlock()
	if len(data) > files.MaxTerminalArchiveBytes {
		err = fmt.Errorf("terminal archive exceeds %d bytes", files.MaxTerminalArchiveBytes)
	}
	if err != nil {
		data = ""
	}
	if err != nil {
		log.Printf("terminal archive capture %s: %v", s.info.ID, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = files.Run(ctx, s.user, files.Request{Operation: "terminal-record", Instance: s.manager.HistoryInstance, Path: s.info.ID, Terminal: &record, Archive: json.RawMessage(data)})
	if err != nil {
		log.Printf("terminal archive save %s: %v", s.info.ID, err)
	}
}

func (s *Session) checkpoint() {
	s.manager.mu.Lock()
	defer s.manager.mu.Unlock()
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if !closed {
		s.checkpointLocked()
	}
}

func (s *Session) watchArchive() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	ticks := 0
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			s.mu.Lock()
			if !s.closed && !s.archiveDead {
				_, _ = s.engine.call("sampleArchive")
			}
			dirty := s.archiveDirty
			ticks++
			if ticks%5 == 0 {
				s.archiveDirty = false
			}
			s.mu.Unlock()
			if ticks%5 == 0 && dirty {
				s.checkpoint()
			}
		}
	}
}

func (m *Manager) ArchiveInventory(ctx context.Context, user identity.User) ([]Info, error) {
	if m.HistoryInstance == "" {
		return m.List(user), nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	response, err := files.Run(ctx, user, files.Request{Operation: "terminal-list", Instance: m.HistoryInstance})
	if err != nil {
		return nil, err
	}
	result := []Info{}
	seen := map[string]bool{}
	for _, s := range m.sessions {
		if s.user.UID == user.UID {
			result = append(result, s.Info())
			seen[s.info.ID] = true
		}
	}
	for _, record := range response.Terminals {
		if !seen[record.ID] {
			result = append(result, archivedInfo(record))
		}
	}
	return result, nil
}

func archivedInfo(record files.TerminalRecord) Info {
	return Info{ID: record.ID, Name: record.Name, Directory: record.Directory, Exited: true, ClosedAt: record.ClosedAt}
}

func (m *Manager) Archive(ctx context.Context, user identity.User, id string) (json.RawMessage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.sessions[id]; s != nil && s.user.UID == user.UID {
		s.checkpointLocked()
	}
	response, err := files.Run(ctx, user, files.Request{Operation: "terminal-archive", Instance: m.HistoryInstance, Path: id})
	return response.Archive, err
}

func (m *Manager) CloseArchive(ctx context.Context, user identity.User, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, err := files.Run(ctx, user, files.Request{Operation: "terminal-close", Instance: m.HistoryInstance, Path: id})
	return err
}
