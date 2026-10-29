package files

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"
	"tuxee/internal/i18n"
)

const InputHistoryEntries = 50
const InputHistoryEntryBytes = 64 << 10
const maxInputHistoryJSON = InputHistoryEntries*(6*InputHistoryEntryBytes+3) + 2

const DefaultClosedHistoryHours = 168
const MaxClosedHistoryHours = 876000
const MaxTerminalArchiveBytes = 6 << 20

type TerminalRecord struct {
	InstanceID   string     `json:"instanceId"`
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	Directory    string     `json:"directory"`
	State        string     `json:"state"`
	StartedAt    *time.Time `json:"startedAt,omitempty"`
	TerminatedAt *time.Time `json:"terminatedAt,omitempty"`
	FoundDeadAt  *time.Time `json:"foundDeadAt,omitempty"`
	ExpiresAt    *time.Time `json:"expiresAt,omitempty"`
	ClosedAt     *time.Time `json:"closedAt,omitempty"`
}

func terminalID(id string) bool {
	_, err := hex.DecodeString(id)
	return len(id) == 24 && err == nil
}

func readTerminalFile(path string, limit int64) ([]byte, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, i18n.New("backend.files.invalidWorkerRequest")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err == nil && int64(len(data)) > limit {
		err = i18n.New("backend.files.invalidWorkerRequest")
	}
	return data, err
}

func terminalFiles(ctx context.Context, r Request) (Response, error) {
	if r.Instance == "" || len(r.Instance) > 128 || len(r.Content) > InputHistoryEntryBytes {
		return Response{}, i18n.New("backend.files.invalidWorkerRequest")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return Response{}, err
	}
	state := os.Getenv("XDG_STATE_HOME")
	if !filepath.IsAbs(state) {
		state = filepath.Join(home, ".local", "state")
	}
	base := filepath.Join(state, "tuxee", "terminals")
	if r.Operation == "terminal-prune" || r.Operation == "terminal-list" {
		return reconcileTerminals(ctx, base, r)
	}
	if r.Operation == "terminal-archive" || r.Operation == "terminal-record" || r.Operation == "terminal-close" || r.Operation == "terminal-delete" {
		return terminalArchive(base, r)
	}
	if r.Operation != "terminal-history" || !terminalID(r.Path) {
		return Response{}, i18n.New("backend.files.invalidWorkerRequest")
	}
	if err := prepareTerminalFolder(base, r.Path, r.Instance); err != nil {
		return Response{}, err
	}
	path := filepath.Join(base, r.Path, "input-history.json")
	history := []string{}
	data, err := readTerminalFile(path, maxInputHistoryJSON)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Response{}, err
	}
	if err == nil {
		if err := json.Unmarshal(data, &history); err != nil {
			return Response{}, err
		}
		if len(data) > maxInputHistoryJSON || len(history) > InputHistoryEntries {
			return Response{}, i18n.New("backend.files.invalidWorkerRequest")
		}
		for _, text := range history {
			if len(text) > InputHistoryEntryBytes {
				return Response{}, i18n.New("backend.terminal.inputIsTooLarge")
			}
		}
	}
	if r.Content != "" && (len(history) == 0 || history[len(history)-1] != r.Content) {
		history = append(history, r.Content)
		if len(history) > InputHistoryEntries {
			history = history[len(history)-InputHistoryEntries:]
		}
		data, err = json.Marshal(history)
		if err == nil {
			err = replaceFile(path, data)
		}
		if err != nil {
			return Response{}, err
		}
	}
	return Response{History: history}, nil
}

func prepareTerminalFolder(base, id, instance string) error {
	path := filepath.Join(base, id)
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return os.ErrPermission
	}
	metaPath := filepath.Join(path, "meta.json")
	data, err := readTerminalFile(metaPath, 16384)
	if errors.Is(err, os.ErrNotExist) {
		data, _ = json.Marshal(TerminalRecord{InstanceID: instance, ID: id, Name: "Terminal", State: "live"})
		return replaceFile(metaPath, data)
	}
	if err != nil {
		return err
	}
	var meta TerminalRecord
	if err := json.Unmarshal(data, &meta); err != nil {
		return err
	}
	if meta.InstanceID != instance {
		return os.ErrPermission
	}
	return nil
}
