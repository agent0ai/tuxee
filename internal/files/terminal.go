package files

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"syscall"
	"tuxee/internal/i18n"
)

const InputHistoryEntries = 50
const InputHistoryEntryBytes = 64 << 10
const maxInputHistoryJSON = InputHistoryEntries*(6*InputHistoryEntryBytes+3) + 2

type terminalMetadata struct {
	InstanceID string `json:"instanceId"`
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
	return io.ReadAll(io.LimitReader(file, limit+1))
}

func terminalFiles(ctx context.Context, r Request) (Response, error) {
	if r.Instance == "" || len(r.Instance) > 128 || len(r.Content) > InputHistoryEntryBytes {
		return Response{}, i18n.New("backend.files.invalidWorkerRequest")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return Response{}, err
	}
	base := filepath.Join(home, ".config", "tuxee", "terminals")
	if r.Operation == "terminal-prune" {
		for _, id := range r.Paths {
			if !terminalID(id) {
				return Response{}, i18n.New("backend.files.invalidWorkerRequest")
			}
			if err := prepareTerminalFolder(base, id, r.Instance); err != nil {
				return Response{}, err
			}
		}
		entries, err := os.ReadDir(base)
		if errors.Is(err, os.ErrNotExist) {
			return Response{}, nil
		}
		if err != nil {
			return Response{}, err
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return Response{}, err
			}
			if !entry.IsDir() || !terminalID(entry.Name()) || slices.Contains(r.Paths, entry.Name()) {
				continue
			}
			path := filepath.Join(base, entry.Name())
			data, err := readTerminalFile(filepath.Join(path, "meta.json"), 4096)
			var meta terminalMetadata
			if err != nil || json.Unmarshal(data, &meta) != nil || meta.InstanceID != r.Instance {
				continue
			}
			// shortcut: discard dead sessions; replace with state/expiry transitions when archives ship.
			if err := os.RemoveAll(path); err != nil {
				return Response{}, err
			}
		}
		return Response{}, nil
	}
	if !terminalID(r.Path) {
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
	data, err := readTerminalFile(metaPath, 4096)
	if errors.Is(err, os.ErrNotExist) {
		data, _ = json.Marshal(terminalMetadata{InstanceID: instance})
		return replaceFile(metaPath, data)
	}
	if err != nil {
		return err
	}
	var meta terminalMetadata
	if err := json.Unmarshal(data, &meta); err != nil {
		return err
	}
	if meta.InstanceID != instance {
		return os.ErrPermission
	}
	return nil
}
