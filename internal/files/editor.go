package files

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"tuxee/internal/i18n"

	"golang.org/x/sys/unix"
)

const maxEditorPositions = 65536
const maxEditorMetadata = 8 << 20

type EditorPosition struct {
	Offset int64 `json:"offset"`
	Line   int   `json:"line"`
}
type EditorEdit struct {
	Page       TextPage `json:"page"`
	Bytes      int64    `json:"bytes"`
	LineBreaks int      `json:"lineBreaks"`
}
type EditorState struct {
	Path      string           `json:"path"`
	Version   string           `json:"version,omitempty"`
	Positions []EditorPosition `json:"positions"`
	Index     int              `json:"index"`
	Anchor    int              `json:"anchor"`
	Head      int              `json:"head"`
	Top       float64          `json:"top"`
	Left      float64          `json:"left"`
	Syntax    string           `json:"syntax"`
	Edits     []EditorEdit     `json:"edits"`
}

func (state *EditorState) validate() error {
	if state == nil || !filepath.IsAbs(state.Path) || len(state.Path) > 4096 || strings.ContainsRune(state.Path, 0) || len(state.Syntax) > 32 || len(state.Positions) == 0 || len(state.Positions) > maxEditorPositions || state.Index < 0 || state.Index >= len(state.Positions) || state.Anchor < 0 || state.Head < 0 || state.Anchor > MaxTextSize || state.Head > MaxTextSize || state.Top < 0 || state.Left < 0 || len(state.Edits) > maxEditorPositions {
		return i18n.New("backend.files.invalidWorkerRequest")
	}
	for i, p := range state.Positions {
		if p.Offset < 0 || p.Line < 1 || (i == 0 && (p.Offset != 0 || p.Line != 1)) || (i > 0 && p.Offset <= state.Positions[i-1].Offset) {
			return i18n.New("backend.files.invalidWorkerRequest")
		}
	}
	return nil
}

func (state *EditorState) pageRange(offset int64) *TextPage {
	for _, edit := range state.Edits {
		if edit.Page.Offset == offset {
			page := edit.Page
			return &page
		}
	}
	for i, position := range state.Positions {
		if position.Offset == offset && i+1 < len(state.Positions) {
			return &TextPage{Offset: offset, End: state.Positions[i+1].Offset}
		}
	}
	return nil
}

func editorDirectory(path string, create bool) (*os.File, error) {
	if create {
		if err := os.MkdirAll(path, 0700); err != nil {
			return nil, err
		}
	}
	f, err := os.OpenFile(path, os.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err == nil && (info.Mode().Perm()&0077 != 0 || info.Sys().(*syscall.Stat_t).Uid != uint32(os.Geteuid())) {
		err = os.ErrPermission
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}
func editorBase(instance string, create bool) (*os.File, error) {
	if instance == "" || len(instance) > 128 {
		return nil, os.ErrInvalid
	}
	terminals, err := terminalBase()
	if err != nil {
		return nil, err
	}
	parent, err := editorDirectory(filepath.Join(filepath.Dir(terminals), "editors"), create)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	return editorDirectory(fdPath(parent, textVersion([]byte(instance))), create)
}
func editorPageName(offset int64) string { return "page-" + strconv.FormatInt(offset, 10) + ".txt" }

// shortcut: checkpoints span separate atomic files; add journaling only if crash-atomic drafts are required.
func writeEditorState(dir *os.File, state *EditorState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if len(data) > maxEditorMetadata {
		return i18n.New("backend.files.workerRequestTooLarge")
	}
	return replaceFile(fdPath(dir, "session.json"), data)
}
func clearEditor(dir *os.File) error {
	entries, err := os.ReadDir(fdPath(dir, "."))
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == "session.json" || entry.Name() == "base" || strings.HasPrefix(entry.Name(), "page-") || strings.HasPrefix(entry.Name(), ".settings-") {
			if err := os.Remove(fdPath(dir, entry.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}

func editorOperation(ctx context.Context, r Request) (Response, error) {
	base, err := editorBase(r.Instance, r.Operation != "editor-prune" && r.Operation != "editor-load")
	if errors.Is(err, os.ErrNotExist) {
		return Response{}, nil
	}
	if err != nil {
		return Response{}, err
	}
	defer base.Close()
	// Serialize checkpoints, commits and orphan cleanup across credential-dropped workers.
	if err = unix.Flock(int(base.Fd()), unix.LOCK_EX); err != nil {
		return Response{}, err
	}
	if r.Operation == "editor-prune" {
		keep := map[string]bool{}
		for _, id := range r.Paths {
			keep[textVersion([]byte(id))] = true
		}
		entries, err := os.ReadDir(fdPath(base, "."))
		if err != nil {
			return Response{}, err
		}
		for _, entry := range entries {
			_, valid := hex.DecodeString(entry.Name())
			if len(entry.Name()) == 64 && valid == nil && !keep[entry.Name()] {
				if err := os.RemoveAll(fdPath(base, entry.Name())); err != nil {
					return Response{}, err
				}
			}
		}
		return Response{}, nil
	}
	if r.EditorID == "" || len(r.EditorID) > 80 {
		return Response{}, os.ErrInvalid
	}
	dir, err := editorDirectory(fdPath(base, textVersion([]byte(r.EditorID))), r.Operation == "editor-open")
	if errors.Is(err, os.ErrNotExist) && r.Operation == "editor-load" {
		return Response{}, nil
	}
	if err != nil {
		return Response{}, err
	}
	defer dir.Close()
	if r.Operation == "editor-close" {
		return Response{}, clearEditor(dir)
	}
	if r.Operation == "editor-open" {
		state := &EditorState{Path: r.Path, Positions: []EditorPosition{{Line: 1}}, Edits: []EditorEdit{}}
		if err := state.validate(); err != nil {
			return Response{}, err
		}
		value, err := readText(ctx, r.Path, 0, "")
		if err != nil {
			return Response{}, err
		}
		state.Version = value.Version
		if err := clearEditor(dir); err != nil {
			return Response{}, err
		}
		return Response{Editor: state}, writeEditorState(dir, state)
	}
	data, err := readTerminalFile(fdPath(dir, "session.json"), maxEditorMetadata)
	if errors.Is(err, os.ErrNotExist) && r.Operation == "editor-load" {
		return Response{}, nil
	}
	if err != nil {
		return Response{}, err
	}
	var state EditorState
	if err = json.Unmarshal(data, &state); err != nil {
		return Response{}, err
	}
	if err = state.validate(); err != nil {
		return Response{}, err
	}
	source := state.Path
	if info, err := os.Lstat(fdPath(dir, "base")); err == nil {
		if !info.Mode().IsRegular() {
			return Response{}, os.ErrInvalid
		}
		source = fdPath(dir, "base")
	} else if !errors.Is(err, os.ErrNotExist) {
		return Response{}, err
	}
	switch r.Operation {
	case "editor-load":
		return Response{Editor: &state}, nil
	case "editor-read":
		value, err := readEditorPage(ctx, source, r.Offset, state.pageRange(r.Offset))
		if err != nil {
			return Response{}, err
		}
		original := value.Content
		value.Original = &original
		for _, edit := range state.Edits {
			if edit.Page.Offset == r.Offset {
				data, err := readTerminalFile(fdPath(dir, editorPageName(r.Offset)), MaxTextSize)
				if err != nil {
					return Response{}, err
				}
				value.Content = string(data)
				value.Page = &edit.Page
				break
			}
		}
		value.Editor = &state
		return value, nil
	case "editor-checkpoint":
		if err := r.Editor.validate(); err != nil {
			return Response{}, err
		}
		if r.Editor.Path != state.Path {
			return Response{}, os.ErrInvalid
		}
		if r.Page != nil && r.Editor.Version != state.Version {
			state.Version = ""
		}
		r.Editor.Edits = state.Edits
		r.Editor.Version = state.Version
		if r.Page != nil {
			breaks, err := validateTextPage(r.Content)
			if err != nil {
				return Response{}, err
			}
			p := r.Page
			if p.Offset < 0 || p.End < p.Offset || p.End-p.Offset > MaxTextSize || p.End > p.Total {
				return Response{}, os.ErrInvalid
			}
			if source == state.Path {
				if err := snapshotEditor(ctx, state.Path, fdPath(dir, "base")); err != nil {
					return Response{}, err
				}
				source = fdPath(dir, "base")
			}
			original, err := readEditorPage(ctx, source, p.Offset, p)
			if err != nil {
				return Response{}, err
			}
			edits := make([]EditorEdit, 0, len(state.Edits)+1)
			for _, edit := range state.Edits {
				if edit.Page.Offset != p.Offset {
					edits = append(edits, edit)
				}
			}
			if r.Content != original.Content {
				if err := replaceFile(fdPath(dir, editorPageName(p.Offset)), []byte(r.Content)); err != nil {
					return Response{}, err
				}
				edits = append(edits, EditorEdit{Page: *original.Page, Bytes: int64(len(r.Content)), LineBreaks: breaks})
			}
			sort.Slice(edits, func(i, j int) bool { return edits[i].Page.Offset < edits[j].Page.Offset })
			r.Editor.Edits = edits
		}
		return Response{Editor: r.Editor}, writeEditorState(dir, r.Editor)
	case "editor-save":
		if r.Mode != "" && r.Mode != "overwrite" && r.Mode != "copy" {
			return Response{}, i18n.New("backend.files.invalidWorkerRequest")
		}
		if len(state.Edits) == 0 {
			return Response{Editor: &state}, nil
		}
		offset := state.Positions[state.Index].Offset
		current, err := readEditorPage(ctx, source, offset, state.pageRange(offset))
		if err != nil {
			return Response{}, err
		}
		currentBytes, currentBreaks := current.Page.End-current.Page.Offset, current.Page.LineBreaks
		total := current.Page.Total
		for _, edit := range state.Edits {
			total += edit.Bytes - (edit.Page.End - edit.Page.Offset)
			if edit.Page.Offset == current.Page.Offset {
				currentBytes, currentBreaks = edit.Bytes, edit.LineBreaks
			}
		}
		positions := []EditorPosition{}
		for i, p := range state.Positions[:state.Index+1] {
			originalOffset := state.Positions[i].Offset
			for _, edit := range state.Edits {
				if edit.Page.Offset < originalOffset {
					p.Offset += edit.Bytes - (edit.Page.End - edit.Page.Offset)
					p.Line += edit.LineBreaks - edit.Page.LineBreaks
				}
			}
			if len(positions) > 0 && positions[len(positions)-1].Offset == p.Offset {
				positions[len(positions)-1] = p
			} else {
				positions = append(positions, p)
			}
		}
		state.Positions = positions
		state.Index = len(positions) - 1
		page := &TextPage{Offset: positions[state.Index].Offset, End: positions[state.Index].Offset + currentBytes, Total: total, LineBreaks: currentBreaks}
		if page.End < total && page.End > page.Offset {
			state.Positions = append(state.Positions, EditorPosition{Offset: page.End, Line: positions[state.Index].Line + currentBreaks})
		}
		if err := saveEditor(ctx, dir, &state, r.Mode); err != nil {
			return Response{}, err
		}
		state.Edits = []EditorEdit{}
		if err := clearEditor(dir); err != nil {
			return Response{}, err
		}
		return Response{Editor: &state, Page: page}, writeEditorState(dir, &state)

	default:
		return Response{}, i18n.New("backend.files.invalidWorkerRequest")
	}
}

// Keep edited ranges fixed even when a saved page is shorter than the reader's page budget.
func readEditorPage(ctx context.Context, path string, offset int64, page *TextPage) (Response, error) {
	if page == nil {
		return readText(ctx, path, offset, "")
	}
	file, err := os.OpenFile(path, os.O_RDONLY|unix.O_NONBLOCK, 0)
	if err != nil {
		return Response{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return Response{}, err
	}
	if !info.Mode().IsRegular() {
		return Response{}, os.ErrInvalid
	}
	end := page.End
	if end == page.Total {
		end = info.Size()
	}
	if offset < 0 || end < offset || end > info.Size() || end-offset > MaxTextSize {
		return Response{}, os.ErrInvalid
	}
	data, err := io.ReadAll(&contextReader{ctx, io.NewSectionReader(file, offset, end-offset)})
	if err != nil {
		return Response{}, err
	}
	breaks, err := validateTextPage(string(data))
	if err != nil {
		return Response{}, err
	}
	return Response{Content: string(data), Page: &TextPage{Offset: offset, End: end, Total: info.Size(), LineBreaks: breaks, Hash: textVersion(data)}}, nil
}

func snapshotEditor(ctx context.Context, path, destination string) error {
	source, err := os.OpenFile(path, os.O_RDONLY|unix.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return os.ErrInvalid
	}
	out, err := os.CreateTemp(filepath.Dir(destination), ".settings-")
	if err != nil {
		return err
	}
	defer out.Close()
	defer os.Remove(out.Name())
	if err = unix.IoctlFileClone(int(out.Fd()), int(source.Fd())); err != nil {
		if _, err = io.CopyBuffer(out, &contextReader{ctx, source}, make([]byte, 128<<10)); err != nil {
			return err
		}
	}
	if err = out.Sync(); err != nil {
		return err
	}
	if err = textUnchanged(source, path, info); err != nil {
		return err
	}
	return os.Rename(out.Name(), destination)
}

func saveEditor(ctx context.Context, dir *os.File, state *EditorState, mode string) error {
	source, err := os.OpenFile(fdPath(dir, "base"), os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer source.Close()
	original, err := source.Stat()
	if err != nil {
		return err
	}
	if !original.Mode().IsRegular() {
		return os.ErrInvalid
	}
	total, end := original.Size(), int64(0)
	for _, edit := range state.Edits {
		if edit.Page.Offset < end || edit.Page.End < edit.Page.Offset || edit.Page.End > original.Size() || edit.Bytes < 0 || edit.Bytes > MaxTextSize {
			return os.ErrInvalid
		}
		total += edit.Bytes - (edit.Page.End - edit.Page.Offset)
		end = edit.Page.End
	}
	write := func(out io.Writer) (int64, error) {
		var written, offset int64
		buffer := make([]byte, 128<<10)
		for _, edit := range state.Edits {
			n, err := io.CopyBuffer(out, &contextReader{ctx, io.NewSectionReader(source, offset, edit.Page.Offset-offset)}, buffer)
			written += n
			if err != nil {
				return written, err
			}
			data, err := readTerminalFile(fdPath(dir, editorPageName(edit.Page.Offset)), MaxTextSize)
			if err != nil {
				return written, err
			}
			if int64(len(data)) != edit.Bytes {
				return written, os.ErrInvalid
			}
			n, err = io.CopyBuffer(out, &contextReader{ctx, strings.NewReader(string(data))}, buffer)
			written += n
			if err != nil {
				return written, err
			}
			offset = edit.Page.End
		}
		n, err := io.CopyBuffer(out, &contextReader{ctx, io.NewSectionReader(source, offset, original.Size()-offset)}, buffer)
		return written + n, err
	}
	real, err := filepath.EvalSymlinks(state.Path)
	if mode == "copy" || mode == "overwrite" && errors.Is(err, os.ErrNotExist) {
		staged, err := os.CreateTemp(filepath.Dir(state.Path), ".tuxee-edit-*")
		if err != nil {
			return err
		}
		defer staged.Close()
		defer os.Remove(staged.Name())
		written, err := write(staged)
		if err != nil {
			return err
		}
		if written != total {
			return i18n.New("backend.files.incompleteFileSave")
		}
		if err := staged.Sync(); err != nil {
			return err
		}
		path, err := createDestination(ctx, state.Path, false, mode == "copy", func(path string) error {
			if mode == "copy" && path == state.Path {
				return os.ErrExist
			}
			return unix.Renameat2(unix.AT_FDCWD, staged.Name(), unix.AT_FDCWD, path, unix.RENAME_NOREPLACE)
		})
		if errors.Is(err, os.ErrExist) {
			return errTextChanged
		}
		if err != nil {
			return err
		}
		info, err := staged.Stat()
		if err != nil {
			return err
		}
		state.Path, state.Version = path, textFileVersion(info)
		return nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return errTextChanged
	}
	if err != nil {
		return err
	}
	if mode != "overwrite" {
		info, err := os.Stat(real)
		if errors.Is(err, os.ErrNotExist) || err == nil && state.Version != textFileVersion(info) {
			return errTextChanged
		}
		if err != nil {
			return err
		}
	}
	target, err := os.OpenFile(real, os.O_RDWR|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if errors.Is(err, os.ErrNotExist) {
		return errTextChanged
	}
	if err != nil {
		return err
	}
	defer target.Close()
	if err = unix.Flock(int(target.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return err
	}
	info, err := target.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return os.ErrInvalid
	}
	if mode != "overwrite" && state.Version != textFileVersion(info) {
		return errTextChanged
	}
	saved, err := replaceText(ctx, target, real, info, total, write)
	if err != nil {
		return err
	}
	state.Version = textFileVersion(saved)
	return nil
}
