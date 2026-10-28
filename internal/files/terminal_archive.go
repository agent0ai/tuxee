package files

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"tuxee/internal/i18n"
)

func terminalRecord(base, id, instance string) (TerminalRecord, error) {
	var record TerminalRecord
	if !terminalID(id) {
		return record, i18n.New("backend.terminal.terminalNotFound")
	}
	path := filepath.Join(base, id)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return record, i18n.New("backend.terminal.terminalNotFound")
	}
	if err != nil {
		return record, err
	}
	if !info.IsDir() {
		return record, os.ErrPermission
	}
	data, err := readTerminalFile(filepath.Join(path, "meta.json"), 16384)
	if errors.Is(err, os.ErrNotExist) {
		return record, i18n.New("backend.terminal.terminalNotFound")
	}
	if err != nil {
		return record, err
	}
	if err = json.Unmarshal(data, &record); err != nil {
		return record, err
	}
	if record.InstanceID != instance {
		return record, i18n.New("backend.terminal.terminalNotFound")
	}
	record.ID = id
	if record.Name == "" {
		record.Name = "Terminal"
	}
	return record, nil
}

func saveTerminalRecord(base string, record TerminalRecord) error {
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return replaceFile(filepath.Join(base, record.ID, "meta.json"), data)
}

func reconcileTerminals(ctx context.Context, base string, r Request) (Response, error) {
	for _, id := range r.Paths {
		if !terminalID(id) {
			return Response{}, i18n.New("backend.files.invalidWorkerRequest")
		}
		if err := prepareTerminalFolder(base, id, r.Instance); err != nil {
			return Response{}, err
		}
	}
	hours := DefaultClosedHistoryHours
	if r.Operation == "terminal-prune" {
		settings, _, err := execute(ctx, Request{Operation: "settings-load"}, nil)
		if err != nil {
			return Response{}, err
		}
		var value struct {
			Hours *int `json:"closedTerminalHistoryHours"`
		}
		if err := json.Unmarshal(settings.Settings, &value); err != nil {
			return Response{}, err
		}
		if value.Hours != nil && *value.Hours >= 0 && *value.Hours <= MaxClosedHistoryHours {
			hours = *value.Hours
		}
	}
	entries, err := os.ReadDir(base)
	if errors.Is(err, os.ErrNotExist) {
		return Response{}, nil
	}
	if err != nil {
		return Response{}, err
	}
	result := Response{}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return Response{}, err
		}
		if !entry.IsDir() || !terminalID(entry.Name()) {
			continue
		}
		record, err := terminalRecord(base, entry.Name(), r.Instance)
		if err != nil {
			continue
		}
		if r.Operation == "terminal-prune" {
			if record.State == "closed" && record.ClosedAt != nil && time.Since(*record.ClosedAt).Hours() >= float64(hours) {
				if err := os.RemoveAll(filepath.Join(base, record.ID)); err != nil {
					return Response{}, err
				}
				continue
			}
			if record.State != "closed" {
				state := "dead"
				if slices.Contains(r.Paths, record.ID) {
					state = "live"
				}
				if record.State != state {
					record.State = state
					if err := saveTerminalRecord(base, record); err != nil {
						return Response{}, err
					}
				}
			}
		}
		result.Terminals = append(result.Terminals, record)
	}
	return result, nil
}

func terminalArchive(base string, r Request) (Response, error) {
	if !terminalID(r.Path) {
		return Response{}, i18n.New("backend.terminal.terminalNotFound")
	}
	if r.Operation == "terminal-record" {
		if r.Terminal == nil || len(r.Archive) > MaxTerminalArchiveBytes {
			return Response{}, i18n.New("backend.files.invalidWorkerRequest")
		}
		if err := prepareTerminalFolder(base, r.Path, r.Instance); err != nil {
			return Response{}, err
		}
	}
	record, err := terminalRecord(base, r.Path, r.Instance)
	if err != nil {
		return Response{}, err
	}
	path := filepath.Join(base, r.Path)
	switch r.Operation {
	case "terminal-record":
		// A late checkpoint must never reopen an explicitly closed archive.
		if record.State == "closed" {
			return Response{}, nil
		}
		value := *r.Terminal
		if (value.State != "live" && value.State != "dead") || len(value.Name) > 80 || len(value.Directory) > 4096 {
			return Response{}, i18n.New("backend.files.invalidWorkerRequest")
		}
		value.ID, value.InstanceID, value.ClosedAt = r.Path, r.Instance, nil
		if len(r.Archive) > 0 {
			if err := writeTerminalArchive(path, r.Archive); err != nil {
				return Response{}, err
			}
		}
		return Response{}, saveTerminalRecord(base, value)
	case "terminal-close":
		if record.State != "closed" {
			now := time.Now().UTC()
			record.State, record.ClosedAt = "closed", &now
			if err := saveTerminalRecord(base, record); err != nil {
				return Response{}, err
			}
		}
		return Response{}, nil
	default:
		data, err := readTerminalArchive(path)
		return Response{Archive: data}, err
	}
}

type TerminalArchive struct {
	Version    int       `json:"version"`
	CapturedAt time.Time `json:"capturedAt"`
	Text       string    `json:"text"`
}

func validateTerminalArchive(value TerminalArchive) error {
	if value.Version != 2 || value.CapturedAt.IsZero() || len(value.Text) > MaxTerminalArchiveBytes {
		return i18n.New("backend.files.invalidWorkerRequest")
	}
	return nil
}

func writeTerminalArchive(path string, data []byte) error {
	var value TerminalArchive
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	if err := validateTerminalArchive(value); err != nil {
		return err
	}
	if err := replaceFile(filepath.Join(path, "output.txt"), []byte(value.Text)); err != nil {
		return err
	}
	value.Text = ""
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return replaceFile(filepath.Join(path, "output.json"), data)
}

func readTerminalArchive(path string) (json.RawMessage, error) {
	data, err := readTerminalFile(filepath.Join(path, "output.json"), 4096)
	if errors.Is(err, os.ErrNotExist) {
		return json.RawMessage(`null`), nil
	}
	if err != nil {
		return nil, err
	}
	var value TerminalArchive
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	if value.Version == 1 {
		// Early previews saved separate buffers without transition positions.
		var old struct {
			Normal struct {
				CapturedAt time.Time `json:"capturedAt"`
			} `json:"normal"`
			Alternate *struct {
				CapturedAt time.Time `json:"capturedAt"`
			} `json:"alternate"`
		}
		if err := json.Unmarshal(data, &old); err != nil {
			return nil, err
		}
		normal, err := readTerminalFile(filepath.Join(path, "normal.txt"), MaxTerminalArchiveBytes)
		if err != nil {
			return nil, err
		}
		value = TerminalArchive{Version: 2, CapturedAt: old.Normal.CapturedAt, Text: strings.TrimRight(string(normal), " \r\n")}
		if old.Alternate != nil {
			alternate, err := readTerminalFile(filepath.Join(path, "alternate.txt"), MaxTerminalArchiveBytes)
			if err != nil {
				return nil, err
			}
			if value.Text != "" {
				value.Text += "\n"
			}
			value.Text += strings.TrimRight(string(alternate), " \r\n")
		}
	} else {
		data, err = readTerminalFile(filepath.Join(path, "output.txt"), MaxTerminalArchiveBytes)
		if err != nil {
			return nil, err
		}
		value.Text = string(data)
	}
	if err := validateTerminalArchive(value); err != nil {
		return nil, err
	}
	return json.Marshal(value)
}
