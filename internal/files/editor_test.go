package files

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEditorDraftPagesAndCleanup(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	path := filepath.Join(t.TempDir(), "large.txt")
	original := strings.Repeat("line\r\n", MaxTextRows*2+20)
	if err := os.WriteFile(path, []byte(original), 0640); err != nil {
		t.Fatal(err)
	}
	call := func(r Request) Response {
		t.Helper()
		r.Instance = "instance"
		r.EditorID = "panel"
		value, err := editorOperation(context.Background(), r)
		if err != nil {
			t.Fatal(r.Operation, err)
		}
		return value
	}
	state := call(Request{Operation: "editor-open", Path: path}).Editor
	base, err := editorBase("instance", false)
	if err != nil {
		t.Fatal(err)
	}
	defer base.Close()
	dir := fdPath(base, textVersion([]byte("panel")))
	if _, err := os.Stat(filepath.Join(dir, "base")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("opening a file copied its body", err)
	}
	first := call(Request{Operation: "editor-read"})
	state.Positions = append(state.Positions, EditorPosition{Offset: first.Page.End, Line: 1 + first.Page.LineBreaks})
	// Shrink page one, and edit page two without saving the target.
	state = call(Request{Operation: "editor-checkpoint", Editor: state, Page: first.Page, Content: "first🙂\r\n"}).Editor
	second := call(Request{Operation: "editor-read", Offset: first.Page.End})
	state.Index = 1
	state = call(Request{Operation: "editor-checkpoint", Editor: state, Page: second.Page, Content: "second\n"}).Editor
	if value, _ := os.ReadFile(path); string(value) != original {
		t.Fatal("checkpoint wrote the target")
	}
	loaded := call(Request{Operation: "editor-load"}).Editor
	if loaded.Index != 1 || len(loaded.Edits) != 2 {
		t.Fatalf("missing navigation/edits: %+v", loaded)
	}
	restored := call(Request{Operation: "editor-read", Offset: first.Page.End})
	if restored.Content != "second\n" || restored.Original == nil || *restored.Original != second.Content {
		t.Fatal("draft did not restore", restored)
	}
	info, err := os.Stat(filepath.Join(dir, editorPageName(0)))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("draft not private", info, err)
	}
	// Another writer may even change the entire file length: the final editing session wins.
	if err := os.WriteFile(path, []byte("external replacement"), 0640); err != nil {
		t.Fatal(err)
	}
	result := call(Request{Operation: "editor-save"})
	expected := "first🙂\r\nsecond\n" + original[second.Page.End:]
	if value, _ := os.ReadFile(path); string(value) != expected {
		t.Fatal("multi-page commit lost bytes", len(value), len(expected))
	}
	if result.Editor.Index != 1 || result.Page.Offset != int64(len("first🙂\r\n")) || result.Page.End != int64(len("first🙂\r\nsecond\n")) {
		t.Fatal("saved page position", result)
	}
	info, _ = os.Stat(path)
	if info.Mode().Perm() != 0640 {
		t.Fatal("save changed permissions")
	}
	// A resized page remains editable, even below the normal page budget.
	state = result.Editor
	call(Request{Operation: "editor-checkpoint", Editor: state, Page: result.Page, Content: "SECOND\r\n"})
	previous := call(Request{Operation: "editor-read"})
	if previous.Content != "first🙂\r\n" {
		t.Fatal("resized pages overlap", previous.Content)
	}
	state.Index = 0
	call(Request{Operation: "editor-checkpoint", Editor: state})
	result = call(Request{Operation: "editor-save"})
	if result.Page.End != int64(len("first🙂\r\n")) {
		t.Fatal("saving from a clean page changed its boundary", result.Page)
	}
	if value, _ := os.ReadFile(path); string(value) != "first🙂\r\nSECOND\r\n"+original[second.Page.End:] {
		t.Fatal("second save lost surrounding bytes")
	}
	// A different installation must survive cleanup; active panels are retained.
	if _, err := editorOperation(context.Background(), Request{Operation: "editor-open", Instance: "other", EditorID: "panel", Path: path}); err != nil {
		t.Fatal(err)
	}
	call(Request{Operation: "editor-prune", Paths: []string{"panel"}})
	if _, err := os.Stat(dir); err != nil {
		t.Fatal("active editor was pruned", err)
	}
	call(Request{Operation: "editor-prune"})
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("orphan was not pruned", err)
	}
	other, err := editorOperation(context.Background(), Request{Operation: "editor-load", Instance: "other", EditorID: "panel"})
	if err != nil || other.Editor == nil {
		t.Fatal("foreign installation was pruned", err)
	}
}

func TestEditorDraftLatestCheckpointAndValidation(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	path := filepath.Join(t.TempDir(), "text")
	os.WriteFile(path, []byte("original\r\n"), 0600)
	run := func(op string, edit *EditorState, page *TextPage, content string) (Response, error) {
		return editorOperation(context.Background(), Request{Operation: op, Instance: "test", EditorID: "panel", Path: path, Editor: edit, Page: page, Content: content})
	}
	opened, err := run("editor-open", nil, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	original, err := run("editor-read", nil, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, content := range []string{"first", "latest"} {
		if _, err := run("editor-checkpoint", opened.Editor, original.Page, content); err != nil {
			t.Fatal(err)
		}
	}
	restored, err := run("editor-read", nil, nil, "")
	if err != nil || restored.Content != "latest" {
		t.Fatal("latest checkpoint did not win", err)
	}
	if _, err := run("editor-checkpoint", opened.Editor, original.Page, strings.Repeat("x", MaxTextSize+1)); err == nil {
		t.Fatal("accepted oversized page")
	}
	if _, err := run("editor-checkpoint", nil, nil, ""); err == nil {
		t.Fatal("accepted null metadata")
	}
	base, err := editorBase("test", false)
	if err != nil {
		t.Fatal(err)
	}
	defer base.Close()
	file := fdPath(base, filepath.Join(textVersion([]byte("panel")), editorPageName(0)))
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(path, file); err != nil {
		t.Fatal(err)
	}
	if _, err := run("editor-read", nil, nil, ""); err == nil {
		t.Fatal("followed draft symlink")
	}
	if _, err := run("editor-save", nil, nil, ""); err == nil {
		t.Fatal("saved a symlink draft")
	}
	if value, _ := os.ReadFile(path); string(value) != "original\r\n" {
		t.Fatal("failed save changed target")
	}
	if _, err := run("editor-close", nil, nil, ""); err != nil {
		t.Fatal(err)
	}
	if value, err := run("editor-load", nil, nil, ""); err != nil || value.Editor != nil {
		t.Fatal("closed editor restored", err)
	}
}
