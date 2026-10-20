package files

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func TestEditorPreservesDataAndRejectsStaleWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "code.go")
	if err := os.WriteFile(path, []byte("package original\n"), 0640); err != nil {
		t.Fatal(err)
	}
	if err := unix.Setxattr(path, "user.tuxee-test", []byte("preserve"), 0); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	original, err := readText(ctx, path, 0, "")
	if err != nil || original.Content != "package original\n" {
		t.Fatal(original, err)
	}
	next, err := saveText(ctx, path, "package edited\n", original.Version, original.Page)
	if err != nil || next.Version == original.Version {
		t.Fatal(next, err)
	}
	if _, err = saveText(ctx, path, "stale", original.Version, original.Page); err == nil {
		t.Fatal("accepted stale write")
	}
	if value, _ := readText(ctx, path, 0, ""); value.Content != "package edited\n" {
		t.Fatal("lost current content")
	}
	attribute := make([]byte, 8)
	if n, err := unix.Getxattr(path, "user.tuxee-test", attribute); err != nil || string(attribute[:n]) != "preserve" {
		t.Fatal("lost file attributes", err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0640 {
		t.Fatal("changed permissions")
	}
	if _, err = saveText(ctx, path, strings.Repeat("x", MaxTextSize+1), next.Version, next.Page); err == nil {
		t.Fatal("accepted oversized edit")
	}
	link := path + ".link"
	if err = os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err = saveText(ctx, link, "via link", next.Version, next.Page); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Lstat(link); err != nil {
		t.Fatal("removed symlink")
	}
	response, stream, err := execute(context.Background(), Request{Operation: "inspect", Path: path}, nil)
	if err != nil || stream != nil || response.Entry.Size != 8 {
		t.Fatal("inspect must not stream", response, err)
	}
}

func TestTextPagesRetainEveryByteAndRespectLimits(t *testing.T) {
	for name, content := range map[string]string{
		"empty":         "",
		"utf8 boundary": strings.Repeat("界🙂", MaxTextSize/7+20),
		"crlf boundary": strings.Repeat("x", MaxTextSize-1) + "\r\nlast\rline\n",
		"row boundary":  strings.Repeat("\r\n", MaxTextRows+12),
		"wrapped rows":  strings.Repeat("\n", MaxTextRows-10) + strings.Repeat("z", 20000),
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "text")
			if err := os.WriteFile(path, []byte(content), 0600); err != nil {
				t.Fatal(err)
			}
			var joined strings.Builder
			var offset int64
			version := ""
			for {
				value, err := readText(context.Background(), path, offset, version)
				if err != nil {
					t.Fatal(err)
				}
				page := value.Page
				if page.Offset != offset || page.End != offset+int64(len(value.Content)) || page.Total != int64(len(content)) || page.Hash != textVersion([]byte(value.Content)) {
					t.Fatalf("invalid page: %+v", page)
				}
				if breaks, err := validateTextPage(value.Content); err != nil || breaks != page.LineBreaks {
					t.Fatal("invalid text shape", breaks, page, err)
				}
				joined.WriteString(value.Content)
				if page.End == page.Total {
					break
				}
				if page.End <= offset {
					t.Fatal("pagination made no progress")
				}
				offset, version = page.End, value.Version
			}
			if joined.String() != content {
				t.Fatal("pagination changed or lost bytes")
			}
		})
	}
}

func TestSavingTextPagePreservesPrefixAndSuffix(t *testing.T) {
	ctx := context.Background()
	original := strings.Repeat("first\r\n", 9000) + strings.Repeat("middle\n", 9000) + strings.Repeat("last\r", 9000)
	for _, location := range []string{"first", "middle", "last"} {
		for _, edit := range []string{"grow", "shrink", "empty"} {
			t.Run(location+"/"+edit, func(t *testing.T) {
				path := filepath.Join(t.TempDir(), "text")
				if err := os.WriteFile(path, []byte(original), 0600); err != nil {
					t.Fatal(err)
				}
				var pages []Response
				var offset int64
				for {
					value, err := readText(ctx, path, offset, "")
					if err != nil {
						t.Fatal(err)
					}
					pages = append(pages, value)
					if value.Page.End == value.Page.Total {
						break
					}
					offset = value.Page.End
				}
				index := map[string]int{"first": 0, "middle": 1, "last": len(pages) - 1}[location]
				value := pages[index]
				content := ""
				if edit == "grow" {
					content = "inserted-界-" + value.Content
				}
				if edit == "shrink" {
					content = value.Content[5:]
				}
				want := original[:value.Page.Offset] + content + original[value.Page.End:]
				saved, err := saveText(ctx, path, content, value.Version, value.Page)
				if err != nil {
					t.Fatal(err)
				}
				got, err := os.ReadFile(path)
				if err != nil || string(got) != want {
					t.Fatal("page save lost untouched bytes", err)
				}
				if saved.Page.Offset != value.Page.Offset || saved.Page.End != value.Page.Offset+int64(len(content)) || saved.Page.Total != int64(len(want)) {
					t.Fatal("wrong saved range", saved.Page)
				}
				// A second save must use the updated range, including a now-empty page.
				again, err := saveText(ctx, path, "next", saved.Version, saved.Page)
				if err != nil {
					t.Fatal(err)
				}
				want = original[:value.Page.Offset] + "next" + original[value.Page.End:]
				got, err = os.ReadFile(path)
				if err != nil || string(got) != want || again.Page.Total != int64(len(want)) {
					t.Fatal("second save lost untouched bytes", err)
				}
				if next, err := readText(ctx, path, again.Page.End, again.Version); err != nil || !strings.HasPrefix(original[value.Page.End:], next.Content) {
					t.Fatal("cannot continue after resized page", err)
				}
			})
		}
	}
}

func TestTextPagesRejectBinarySpecialFilesAndUnsafeWrites(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "text")
	for _, content := range []string{"text\x00garbage", "\xff\xfe", "\x01hidden", "\x7f", strings.Repeat("a", 70000) + "\x00"} {
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		if value, err := readText(ctx, path, 0, ""); !errors.Is(err, errBinaryText) || value.Content != "" {
			t.Fatal("returned binary content", err)
		}
	}
	fifo := path + ".fifo"
	if err := unix.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readText(ctx, fifo, 0, ""); err == nil {
		t.Fatal("accepted FIFO")
	}
	original := strings.Repeat("a", MaxTextSize) + "untouched suffix"
	if err := os.WriteFile(path, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	value, err := readText(ctx, path, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	badHash, badRange := *value.Page, *value.Page
	badHash.Hash = "wrong"
	badRange.End++
	for _, page := range []*TextPage{nil, &badHash, &badRange} {
		if _, err := saveText(ctx, path, "truncated", value.Version, page); err == nil {
			t.Fatal("accepted unsafe range")
		}
	}
	for _, content := range []string{strings.Repeat("\n", MaxTextRows), "\x01", "\xff"} {
		if _, err := saveText(ctx, path, content, value.Version, value.Page); err == nil {
			t.Fatal("accepted invalid page")
		}
	}
	got, _ := os.ReadFile(path)
	if string(got) != original {
		t.Fatal("failed save changed source")
	}
	// Even a change outside the open page, with restored mtime, invalidates its version.
	info, _ := os.Stat(path)
	external := original[:len(original)-1] + "!"
	if err := os.WriteFile(path, []byte(external), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if _, err := readText(ctx, path, value.Page.End, value.Version); !errors.Is(err, errTextChanged) {
		t.Fatal("accepted stale page navigation", err)
	}
	if _, err := saveText(ctx, path, "truncated", value.Version, value.Page); !errors.Is(err, errTextChanged) {
		t.Fatal("accepted stale page save", err)
	}
	got, _ = os.ReadFile(path)
	if string(got) != external {
		t.Fatal("lost external edit")
	}
}

type cancelTextCopy struct {
	context.Context
	checks int
}

func (ctx *cancelTextCopy) Err() error {
	ctx.checks--
	if ctx.checks <= 0 {
		return context.Canceled
	}
	return nil
}

func TestCancelledPageSaveLeavesOriginalIntact(t *testing.T) {
	path := filepath.Join(t.TempDir(), "text")
	original := strings.Repeat("a", 8*MaxTextSize)
	if err := os.WriteFile(path, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	value, err := readText(context.Background(), path, 3*MaxTextSize, "")
	if err != nil {
		t.Fatal(err)
	}
	ctx := &cancelTextCopy{Context: context.Background(), checks: 25}
	if _, err := saveText(ctx, path, "replacement", value.Version, value.Page); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != original {
		t.Fatal("interrupted save truncated original", err)
	}
	leftovers, err := filepath.Glob(filepath.Join(filepath.Dir(path), ".tuxee-edit-*"))
	if err != nil || len(leftovers) != 0 {
		t.Fatal("temporary save left behind", leftovers, err)
	}
}
