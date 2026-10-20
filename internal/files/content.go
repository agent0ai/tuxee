package files

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

const MaxTextSize = 1 << 20
const MaxTextRows = 10000
const TextWrapColumns = 1000

type TextPage struct {
	Offset     int64  `json:"offset"`
	End        int64  `json:"end"`
	Total      int64  `json:"total"`
	LineBreaks int    `json:"lineBreaks"`
	Hash       string `json:"hash"`
}

var errTextChanged = errors.New("file changed; reopen it before editing")
var errBinaryText = errors.New("binary or non-UTF-8 file; download it to view")

func textVersion(data []byte) string { hash := sha256.Sum256(data); return hex.EncodeToString(hash[:]) }
func textFileVersion(info os.FileInfo) string {
	stat := info.Sys().(*syscall.Stat_t)
	return textVersion([]byte(fmt.Sprintf("%d:%d:%d:%d:%d:%d:%d:%d", stat.Dev, stat.Ino, info.Size(), stat.Mtim.Sec, stat.Mtim.Nsec, stat.Ctim.Sec, stat.Ctim.Nsec, stat.Mode)))
}
func textUnchanged(file *os.File, path string, before os.FileInfo) error {
	now, err := file.Stat()
	if err != nil {
		return err
	}
	current, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !os.SameFile(now, current) || textFileVersion(now) != textFileVersion(before) {
		return errTextChanged
	}
	return nil
}
func binaryRune(char rune, width int) bool {
	return char == utf8.RuneError && width == 1 || char < 32 && char != '\n' && char != '\r' && char != '\t' || char == 127
}

func validateTextPage(content string) (int, error) {
	if len(content) > MaxTextSize || !utf8.ValidString(content) {
		return 0, errors.New("editor pages support UTF-8 text up to 1 MiB")
	}
	rows, columns, breaks := 1, 0, 0
	var previous rune
	for _, char := range content {
		if binaryRune(char, utf8.RuneLen(char)) {
			return 0, errBinaryText
		}
		if char == '\r' || char == '\n' {
			if char != '\n' || previous != '\r' {
				rows++
				breaks++
			}
			columns = 0
		} else {
			if columns == TextWrapColumns {
				rows++
				columns = 0
			}
			columns++
		}
		if rows > MaxTextRows {
			return 0, errors.New("editor pages support at most 10,000 displayed rows")
		}
		previous = char
	}
	return breaks, nil
}

// Read at most one page, without scanning or hashing the rest of the file.
func readText(ctx context.Context, path string, offset int64, version string) (Response, error) {
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
		return Response{}, errors.New("editor supports regular text files only")
	}
	if offset < 0 || offset > info.Size() {
		return Response{}, errors.New("invalid text page offset")
	}
	if version != "" && version != textFileVersion(info) {
		return Response{}, errTextChanged
	}
	reader := bufio.NewReaderSize(&contextReader{ctx, io.NewSectionReader(file, offset, info.Size()-offset)}, 64<<10)
	var content strings.Builder
	rows, columns, breaks := 1, 0, 0
	for offset+int64(content.Len()) < info.Size() {
		char, width, err := reader.ReadRune()
		if err != nil {
			return Response{}, err
		}
		if binaryRune(char, width) {
			return Response{}, errBinaryText
		}
		token := string(char)
		newline := char == '\n' || char == '\r'
		if char == '\r' {
			if next, _ := reader.Peek(1); len(next) == 1 && next[0] == '\n' {
				_, _ = reader.ReadByte()
				token = "\r\n"
			}
		}
		if content.Len()+len(token) > MaxTextSize {
			break
		}
		if newline || columns == TextWrapColumns {
			if rows == MaxTextRows {
				break
			}
			rows++
			columns = 0
		}
		if newline {
			breaks++
		} else {
			columns++
		}
		content.WriteString(token)
	}
	if err = ctx.Err(); err != nil {
		return Response{}, err
	}
	if err = textUnchanged(file, path, info); err != nil {
		return Response{}, err
	}
	data := content.String()
	return Response{Path: path, Content: data, Version: textFileVersion(info), Page: &TextPage{Offset: offset, End: offset + int64(len(data)), Total: info.Size(), LineBreaks: breaks, Hash: textVersion([]byte(data))}}, nil
}
func preserveAttributes(source, destination *os.File) error {
	size, err := unix.Flistxattr(int(source.Fd()), nil)
	if errors.Is(err, syscall.ENOTSUP) {
		return nil
	}
	if err != nil {
		return err
	}
	names := make([]byte, size)
	if _, err = unix.Flistxattr(int(source.Fd()), names); err != nil {
		return err
	}
	for _, name := range strings.Split(string(names), "\x00") {
		if name == "" || name == "security.capability" {
			continue
		}
		if name == "security.ima" || name == "security.evm" {
			return errors.New("cannot edit an integrity-protected file")
		}
		size, err = unix.Fgetxattr(int(source.Fd()), name, nil)
		if err != nil {
			return err
		}
		value := make([]byte, size)
		if _, err = unix.Fgetxattr(int(source.Fd()), name, value); err != nil {
			return err
		}
		if err = unix.Fsetxattr(int(destination.Fd()), name, value, 0); err != nil {
			return err
		}
	}
	return nil
}

func saveText(ctx context.Context, path, content, version string, page *TextPage) (Response, error) {
	breaks, err := validateTextPage(content)
	if err != nil {
		return Response{}, err
	}
	if page == nil || page.Offset < 0 || page.End < page.Offset || page.End-page.Offset > MaxTextSize || page.Hash == "" || version == "" {
		return Response{}, errors.New("a valid original text page range and hash are required")
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return Response{}, err
	}
	file, err := os.OpenFile(real, os.O_RDWR|unix.O_NONBLOCK|unix.O_NOFOLLOW, 0)
	if err != nil {
		return Response{}, err
	}
	defer file.Close()
	if err = unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return Response{}, errors.New("file is being saved; try again")
	}
	defer unix.Flock(int(file.Fd()), unix.LOCK_UN)
	info, err := file.Stat()
	if err != nil {
		return Response{}, err
	}
	current, err := os.Stat(real)
	if err != nil {
		return Response{}, err
	}
	if !info.Mode().IsRegular() || !os.SameFile(info, current) || textFileVersion(info) != version || page.End > info.Size() {
		return Response{}, errTextChanged
	}
	data, err := io.ReadAll(&contextReader{ctx, io.NewSectionReader(file, page.Offset, page.End-page.Offset)})
	if err != nil {
		return Response{}, err
	}
	if int64(len(data)) != page.End-page.Offset || textVersion(data) != page.Hash {
		return Response{}, errTextChanged
	}
	staged, err := os.CreateTemp(filepath.Dir(real), ".tuxee-edit-*")
	if err != nil {
		return Response{}, err
	}
	defer os.Remove(staged.Name())
	defer staged.Close()
	// A page is a replacement range: retain the complete prefix and suffix.
	source := io.MultiReader(io.NewSectionReader(file, 0, page.Offset), strings.NewReader(content), io.NewSectionReader(file, page.End, info.Size()-page.End))
	written, err := io.CopyBuffer(staged, &contextReader{ctx, source}, make([]byte, 128<<10))
	total := info.Size() - (page.End - page.Offset) + int64(len(content))
	if err != nil {
		return Response{}, err
	}
	if written != total {
		return Response{}, errors.New("incomplete file save")
	}
	stat := info.Sys().(*syscall.Stat_t)
	if err = staged.Chown(int(stat.Uid), int(stat.Gid)); err != nil {
		return Response{}, err
	}
	if err = staged.Chmod(info.Mode().Perm()); err != nil {
		return Response{}, err
	}
	if err = preserveAttributes(file, staged); err != nil {
		return Response{}, err
	}
	if err = staged.Sync(); err != nil {
		return Response{}, err
	}
	if err = ctx.Err(); err != nil {
		return Response{}, err
	}
	if err = textUnchanged(file, real, info); err != nil {
		return Response{}, err
	}
	if err = os.Rename(staged.Name(), real); err != nil {
		return Response{}, err
	}
	saved, err := staged.Stat()
	if err != nil {
		return Response{}, err
	}
	return Response{Path: path, Version: textFileVersion(saved), Page: &TextPage{Offset: page.Offset, End: page.Offset + int64(len(content)), Total: total, LineBreaks: breaks, Hash: textVersion([]byte(content))}}, nil
}
