package terminal

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"
	"tuxee/internal/identity"
)

// StartArchives remembers only accounts that have authenticated to this installation.
func (m *Manager) StartArchives(state string) {
	m.archiveAccountsPath = filepath.Join(state, "terminal-accounts.json")
	m.archiveAccounts = map[string]uint32{}
	if data, err := os.ReadFile(m.archiveAccountsPath); err == nil {
		if len(data) > 1<<20 || json.Unmarshal(data, &m.archiveAccounts) != nil || m.archiveAccounts == nil {
			log.Printf("invalid terminal account registry: %s", m.archiveAccountsPath)
			m.archiveAccounts = map[string]uint32{}
		}
	} else if !os.IsNotExist(err) {
		log.Printf("terminal account registry: %v", err)
	}
	m.archiveStop, m.archiveStopped = make(chan struct{}), make(chan struct{})
	go func() {
		defer close(m.archiveStopped)
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			m.cleanArchives()
			select {
			case <-ticker.C:
			case <-m.archiveStop:
				return
			}
		}
	}()
}

func (m *Manager) RegisterArchiveUser(user identity.User) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.archiveAccountsPath == "" || m.closed {
		return
	}
	if uid, ok := m.archiveAccounts[user.Name]; ok && uid == user.UID {
		return
	}
	m.archiveAccounts[user.Name] = user.UID
	data, err := json.Marshal(m.archiveAccounts)
	if err == nil {
		var file *os.File
		file, err = os.CreateTemp(filepath.Dir(m.archiveAccountsPath), ".terminal-accounts-*")
		if err == nil {
			defer os.Remove(file.Name())
			_, err = file.Write(data)
			if err == nil {
				err = file.Sync()
			}
			if closeErr := file.Close(); err == nil {
				err = closeErr
			}
			if err == nil {
				err = os.Rename(file.Name(), m.archiveAccountsPath)
			}
		}
	}
	if err != nil {
		delete(m.archiveAccounts, user.Name)
		log.Printf("terminal account registry: %v", err)
	}
}

func (m *Manager) cleanArchives() {
	m.mu.Lock()
	accounts := make(map[string]uint32, len(m.archiveAccounts))
	for name, uid := range m.archiveAccounts {
		accounts[name] = uid
	}
	m.mu.Unlock()
	for name, uid := range accounts {
		select {
		case <-m.archiveStop:
			return
		default:
		}
		user, err := identity.Lookup(name)
		if err == nil && user.UID == uid {
			m.PruneHistory(user)
		}
	}
}
