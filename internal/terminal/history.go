package terminal

import (
	"context"
	"log"
	"time"
	"tuxee/internal/files"
	"tuxee/internal/i18n"
	"tuxee/internal/identity"
)

// PruneHistory reconciles this installation's user folders with its live sessions.
func (m *Manager) PruneHistory(user identity.User) {
	if m.HistoryInstance == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	live := []string{}
	for id, s := range m.sessions {
		if s.user.UID != user.UID {
			continue
		}
		s.mu.Lock()
		if !s.closed && !s.info.Exited && !s.archiveDead {
			live = append(live, id)
		}
		s.mu.Unlock()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := files.Run(ctx, user, files.Request{Operation: "terminal-prune", Instance: m.HistoryInstance, Paths: live}); err != nil {
		log.Printf("terminal history cleanup for uid %d: %v", user.UID, err)
	}
}

// InputHistory appends one drawer submission; empty text only reads the history.
func (s *Session) InputHistory(ctx context.Context, text string) ([]string, error) {
	if len(text) > files.InputHistoryEntryBytes {
		return nil, i18n.New("backend.terminal.inputIsTooLarge")
	}
	// Serialize append and cleanup without holding the PTY/output lock during disk I/O.
	s.manager.mu.Lock()
	defer s.manager.mu.Unlock()
	s.mu.Lock()
	alive := !s.closed && !s.info.Exited && !s.archiveDead
	s.mu.Unlock()
	if !alive {
		if text == "" {
			return []string{}, nil
		}
		return nil, i18n.New("terminal.closed")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	response, err := files.Run(ctx, s.user, files.Request{Operation: "terminal-history", Instance: s.manager.HistoryInstance, Path: s.info.ID, Content: text})
	if response.History == nil {
		response.History = []string{}
	}
	return response.History, err
}
