package files

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

type Request struct {
	Content     string          `json:"content,omitempty"`
	Version     string          `json:"version,omitempty"`
	Page        *TextPage       `json:"page,omitempty"`
	Paths       []string        `json:"paths,omitempty"`
	Format      string          `json:"format,omitempty"`
	Password    string          `json:"password,omitempty"`
	Offset      int64           `json:"offset,omitempty"`
	Limit       int64           `json:"limit,omitempty"`
	Operation   string          `json:"operation"`
	Path        string          `json:"path,omitempty"`
	Destination string          `json:"destination,omitempty"`
	Mode        string          `json:"mode,omitempty"`
	Settings    json.RawMessage `json:"settings,omitempty"`
	Size        int64           `json:"size,omitempty"`
	Unique      bool            `json:"unique,omitempty"`
	Parents     bool            `json:"parents,omitempty"`
}

type Entry struct {
	Name      string    `json:"name"`
	Path      string    `json:"path"`
	Directory bool      `json:"directory"`
	Symlink   bool      `json:"symlink"`
	Size      int64     `json:"size"`
	Mode      string    `json:"mode"`
	UID       uint32    `json:"uid"`
	GID       uint32    `json:"gid"`
	Modified  time.Time `json:"modified"`
	Accessed  time.Time `json:"accessed"`
	Changed   time.Time `json:"changed"`
	Link      string    `json:"link,omitempty"`
}

type Response struct {
	Content   string          `json:"content"`
	Version   string          `json:"version,omitempty"`
	Page      *TextPage       `json:"page,omitempty"`
	Formats   []ArchiveFormat `json:"formats,omitempty"`
	Error     string          `json:"error,omitempty"`
	Path      string          `json:"path,omitempty"`
	Entries   []Entry         `json:"entries,omitempty"`
	Entry     *Entry          `json:"entry,omitempty"`
	Truncated bool            `json:"truncated,omitempty"`
	Settings  json.RawMessage `json:"settings,omitempty"`
}

// Worker serves one operation after exec has applied the user's Linux credentials.
func Worker() error {
	syscall.Umask(0077)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-ctx.Done():
			_ = os.Stdin.Close()
		case <-finished:
		}
	}()
	reader := bufio.NewReaderSize(os.Stdin, 64<<10)
	var header []byte
	var err error
	for {
		var part []byte
		part, err = reader.ReadSlice('\n')
		header = append(header, part...)
		if len(header) > 8<<20 {
			return errors.New("worker request too large")
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			break
		}
	}
	if err != nil {
		return errors.New("invalid worker request")
	}
	var request Request
	if err = json.Unmarshal(header, &request); err != nil {
		return err
	}
	if request.Operation == "zip-download" {
		return streamZIP(ctx, request, os.Stdout)
	}
	response, download, err := execute(ctx, request, reader)
	if err != nil {
		response = Response{Error: err.Error()}
	}
	if err = json.NewEncoder(os.Stdout).Encode(response); err != nil {
		if download != nil {
			download.Close()
		}
		return err
	}
	if download != nil {
		defer download.Close()
		var source io.Reader = download
		if request.Limit > 0 {
			source = io.LimitReader(download, request.Limit)
		}
		_, err = io.Copy(os.Stdout, source)
	}
	return err
}

func execute(ctx context.Context, r Request, body io.Reader) (Response, *os.File, error) {
	var response Response
	if r.Operation == "settings-load" || r.Operation == "settings-save" {
		home, err := os.UserHomeDir()
		if err != nil {
			return response, nil, err
		}
		path := filepath.Join(home, ".config", "tuxee", "settings.json")
		if r.Operation == "settings-load" {
			data, err := os.ReadFile(path)
			if errors.Is(err, os.ErrNotExist) {
				return Response{Settings: json.RawMessage(`{}`)}, nil, nil
			}
			if err != nil {
				return response, nil, err
			}
			if len(data) > 512<<10 || !json.Valid(data) {
				return response, nil, errors.New("invalid saved user configuration")
			}
			response.Settings = data
			return response, nil, nil
		}
		if len(r.Settings) > 512<<10 || !json.Valid(r.Settings) {
			return response, nil, errors.New("invalid user configuration")
		}
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return response, nil, err
		}
		return response, nil, replaceFile(path, r.Settings)
	}
	if !filepath.IsAbs(r.Path) || strings.ContainsRune(r.Path, 0) {
		return response, nil, errors.New("path must be absolute")
	}
	r.Path = filepath.Clean(r.Path)
	response.Path = r.Path
	switch r.Operation {
	case "read":
		response, err := readText(ctx, r.Path, r.Offset, r.Version)
		return response, nil, err
	case "write":
		response, err := saveText(ctx, r.Path, r.Content, r.Version, r.Page)
		return response, nil, err
	case "archive-formats":
		response.Formats = archiveFormats()
	case "compress", "extract":
		response.Path = r.Destination
		return response, nil, archive(ctx, r)
	case "list":
		directory, err := os.Open(r.Path)
		if err != nil {
			return response, nil, err
		}
		defer directory.Close()
		entries, err := directory.ReadDir(10001)
		if err != nil && !errors.Is(err, io.EOF) {
			return response, nil, err
		}
		if len(entries) > 10000 {
			entries = entries[:10000]
			response.Truncated = true
		}
		response.Entries = []Entry{}
		for _, entry := range entries {
			info, err := entry.Info()
			if err != nil {
				continue
			}
			value := metadata(filepath.Join(r.Path, entry.Name()), info)
			if value.Symlink {
				if target, e := os.Stat(value.Path); e == nil {
					value.Directory = target.IsDir()
				}
			}
			response.Entries = append(response.Entries, value)
		}
		sort.Slice(response.Entries, func(i, j int) bool {
			a, b := response.Entries[i], response.Entries[j]
			if a.Directory != b.Directory {
				return a.Directory
			}
			return strings.ToLower(a.Name) < strings.ToLower(b.Name)
		})
	case "stat":
		info, err := os.Lstat(r.Path)
		if err != nil {
			return response, nil, err
		}
		value := metadata(r.Path, info)
		response.Entry = &value
	case "mkdir":
		if r.Parents {
			if r.Unique {
				return response, nil, errors.New("cannot combine parents and unique")
			}
			return response, nil, os.MkdirAll(r.Path, 0755)
		}
		path, err := createDestination(ctx, r.Path, true, r.Unique, func(path string) error { return os.Mkdir(path, 0755) })
		response.Path = path
		return response, nil, err
	case "delete":
		if r.Path == "/" {
			return response, nil, errors.New("cannot delete the filesystem root")
		}
		return response, nil, os.RemoveAll(r.Path)
	case "chmod":
		mode, err := strconv.ParseUint(r.Mode, 8, 12)
		if err != nil {
			return response, nil, errors.New("permissions must be octal, for example 0644")
		}
		return response, nil, unix.Chmod(r.Path, uint32(mode))
	case "rename", "move", "copy":
		if !filepath.IsAbs(r.Destination) || strings.ContainsRune(r.Destination, 0) {
			return response, nil, errors.New("destination must be absolute")
		}
		r.Destination = filepath.Clean(r.Destination)
		if r.Path == r.Destination {
			if r.Operation != "copy" {
				return response, nil, nil
			}
			path, err := duplicate(ctx, r.Path)
			response.Path = path
			return response, nil, err
		}
		response.Path = r.Destination
		if r.Operation != "copy" {
			err := unix.Renameat2(unix.AT_FDCWD, r.Path, unix.AT_FDCWD, r.Destination, unix.RENAME_NOREPLACE)
			if err == nil {
				return response, nil, nil
			}
			if !errors.Is(err, syscall.EXDEV) || r.Operation == "rename" {
				return response, nil, err
			}
		}
		if err := copyTree(ctx, r.Path, r.Destination); err != nil {
			return response, nil, err
		}
		if r.Operation == "move" {
			if err := os.RemoveAll(r.Path); err != nil {
				return response, nil, fmt.Errorf("destination copied, but source removal failed: %w", err)
			}
		}
	case "download", "inspect":
		file, err := os.Open(r.Path)
		if err != nil {
			return response, nil, err
		}
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			file.Close()
			return response, nil, errors.New("download requires a regular file")
		}
		value := metadata(r.Path, info)
		response.Entry = &value
		if r.Operation == "inspect" {
			file.Close()
			return response, nil, nil
		}
		if r.Offset < 0 || r.Offset > info.Size() || r.Limit < 0 {
			file.Close()
			return response, nil, errors.New("invalid byte range")
		}
		if _, err = file.Seek(r.Offset, io.SeekStart); err != nil {
			file.Close()
			return response, nil, err
		}
		return response, file, nil
	case "upload":
		path, err := upload(ctx, r.Path, body, r.Size, r.Unique)
		response.Path = path
		return response, nil, err
	default:
		return response, nil, errors.New("unknown file operation")
	}
	return response, nil, nil
}

func metadata(path string, info os.FileInfo) Entry {
	stat := info.Sys().(*syscall.Stat_t)
	value := Entry{Name: filepath.Base(path), Path: path, Directory: info.IsDir(), Symlink: info.Mode()&os.ModeSymlink != 0, Size: info.Size(), Mode: fmt.Sprintf("%04o", stat.Mode&07777), UID: stat.Uid, GID: stat.Gid, Modified: info.ModTime()}
	value.Accessed = time.Unix(stat.Atim.Sec, stat.Atim.Nsec)
	value.Changed = time.Unix(stat.Ctim.Sec, stat.Ctim.Nsec)
	if value.Symlink {
		value.Link, _ = os.Readlink(path)
	}
	return value
}

// The create callback must claim its destination atomically without replacing it.
func createDestination(ctx context.Context, path string, directory, unique bool, create func(string) error) (string, error) {
	ext := ""
	if !directory {
		ext = filepath.Ext(path)
		if ext == filepath.Base(path) {
			ext = ""
		}
	}
	for i := 0; i < 10000; i++ {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		candidate := path
		if i > 0 {
			candidate = fmt.Sprintf("%s (%d)%s", strings.TrimSuffix(path, ext), i, ext)
		}
		err := create(candidate)
		if err == nil {
			return candidate, nil
		}
		if !unique || !errors.Is(err, os.ErrExist) {
			return "", err
		}
	}
	return "", errors.New("too many files with this name")
}

func upload(ctx context.Context, path string, body io.Reader, size int64, unique bool) (string, error) {
	if size < 0 {
		return "", errors.New("upload requires its expected byte size")
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".tuxee-upload-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	n, err := io.Copy(file, &contextReader{ctx, io.LimitReader(body, size+1)})
	if err != nil {
		return "", err
	}
	if n != size {
		return "", errors.New("incomplete upload: received size differs from declared size")
	}
	if err = file.Sync(); err != nil {
		return "", err
	}
	if err = file.Close(); err != nil {
		return "", err
	}
	return createDestination(ctx, path, false, unique, func(destination string) error {
		return unix.Renameat2(unix.AT_FDCWD, file.Name(), unix.AT_FDCWD, destination, unix.RENAME_NOREPLACE)
	})
}

func replaceFile(path string, data []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".settings-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err = file.Write(data); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

// Duplicate chooses a sibling name; atomic publication still rejects races and collisions.
func duplicate(ctx context.Context, source string) (string, error) {
	info, err := os.Lstat(source)
	if err != nil {
		return "", err
	}
	ext := filepath.Ext(source)
	if info.IsDir() || filepath.Base(source) == ext {
		ext = ""
	}
	stem := strings.TrimSuffix(source, ext)
	for n := 1; n <= 10000; n++ {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		suffix := " (copy)"
		if n > 1 {
			suffix = fmt.Sprintf(" (copy %d)", n)
		}
		destination := stem + suffix + ext
		if _, err := os.Lstat(destination); err == nil {
			continue
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		err := copyTree(ctx, source, destination)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		return destination, err
	}
	return "", errors.New("too many copies with this name")
}

func copyTree(ctx context.Context, source, destination string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(destination))
	if err != nil {
		return err
	}
	if info.IsDir() {
		real, err := filepath.EvalSymlinks(source)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(real, parent)
		if err != nil {
			return err
		}
		if relative == "." || relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
			return errors.New("cannot copy a directory into itself")
		}
	}
	staging, err := os.MkdirTemp(parent, ".tuxee-copy-*")
	if err != nil {
		return err
	}
	defer removeStaging(staging)
	staged := filepath.Join(staging, "item")
	if err = copyEntry(ctx, source, staged); err != nil {
		return err
	}
	return unix.Renameat2(unix.AT_FDCWD, staged, unix.AT_FDCWD, destination, unix.RENAME_NOREPLACE)
}

func removeStaging(path string) {
	// Copied read-only directories still need owner access for failed-copy cleanup.
	_ = filepath.WalkDir(path, func(name string, entry os.DirEntry, err error) error {
		if err == nil && entry.IsDir() {
			return os.Chmod(name, 0700)
		}
		return err
	})
	_ = os.RemoveAll(path)
}

func copyEntry(ctx context.Context, source, destination string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(source)
		if err != nil {
			return err
		}
		return os.Symlink(target, destination)
	}
	if info.IsDir() {
		if err = os.Mkdir(destination, 0700); err != nil {
			return err
		}
		dir, err := os.Open(source)
		if err != nil {
			return err
		}
		defer dir.Close()
		for {
			entries, err := dir.ReadDir(256)
			if err != nil && !errors.Is(err, io.EOF) {
				return err
			}
			for _, entry := range entries {
				if err = copyEntry(ctx, filepath.Join(source, entry.Name()), filepath.Join(destination, entry.Name())); err != nil {
					return err
				}
			}
			if errors.Is(err, io.EOF) || len(entries) == 0 {
				break
			}
		}
		return os.Chmod(destination, info.Mode().Perm())
	}
	if !info.Mode().IsRegular() {
		return errors.New("copy supports regular files, directories, and symlinks")
	}
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err = io.Copy(out, &contextReader{ctx, in}); err != nil {
		return err
	}
	if err = out.Chmod(info.Mode().Perm()); err != nil {
		return err
	}
	return out.Sync()
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}
