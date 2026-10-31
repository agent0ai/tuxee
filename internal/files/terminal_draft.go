package files

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"tuxee/internal/i18n"
	"unicode/utf8"
)

const InputDraftBytes = 256 << 10
const MaxInputDraftJSON = 6*InputDraftBytes + 256

type TerminalDraft struct {
	Text     string `json:"text"`
	Open     bool   `json:"open"`
	Revision string `json:"revision"`
}

func terminalDraft(base string, r Request) (Response, error) {
	if r.Draft != nil && (len(r.Draft.Text) > InputDraftBytes || !utf8.ValidString(r.Draft.Text) || len(r.Draft.Revision) > 64) {
		return Response{}, i18n.New("backend.terminal.inputIsTooLarge")
	}
	if _, err := terminalRecord(base, r.Path, r.Instance); err != nil {
		return Response{}, err
	}
	path := filepath.Join(base, r.Path, "input-draft.json")
	var saved TerminalDraft
	data, err := readTerminalFile(path, MaxInputDraftJSON)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Response{}, err
	}
	if err == nil {
		if err := json.Unmarshal(data, &saved); err != nil {
			return Response{}, err
		}
		if len(saved.Text) > InputDraftBytes || saved.Revision == "" || len(saved.Revision) > 64 {
			return Response{}, i18n.New("backend.files.invalidWorkerRequest")
		}
	}
	if draft := r.Draft; draft != nil && (draft.Text != saved.Text || draft.Open != saved.Open) {
		if draft.Revision != saved.Revision {
			return Response{}, i18n.New("term.inputDraftChanged")
		}
		saved = *draft
		saved.Revision = rand.Text()
		data, err = json.Marshal(saved)
		if err == nil {
			err = replaceFile(path, data)
		}
		if err != nil {
			return Response{}, err
		}
	}
	return Response{Draft: &saved}, nil
}
