package files

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const TrashPath = "trash:///"

type trashLocation struct {
	path string
	top  string // Empty for home trash; volume metadata is relative to its mount root.
}

type trashBin struct {
	trashLocation
	dir, files, info *os.File
}

func fdPath(dir *os.File, name string) string {
	return filepath.Join("/proc/self/fd", strconv.Itoa(int(dir.Fd())), name)
}

func privateTrashDirectory(path string, create bool) (*os.File, error) {
	if create {
		if err := os.Mkdir(path, 0700); err != nil && !errors.Is(err, os.ErrExist) {
			return nil, err
		}
	}
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), path)
	info, err := f.Stat()
	if err != nil || info.Sys().(*syscall.Stat_t).Uid != uint32(os.Getuid()) || info.Mode().Perm()&0077 != 0 {
		f.Close()
		return nil, fmt.Errorf("unsafe trash directory: %s (must be private and owned by this user)", path)
	}
	return f, nil
}

func (location trashLocation) open(create, write bool) (*trashBin, error) {
	path := location.path
	var shared *os.File
	if location.top != "" && filepath.Base(filepath.Dir(path)) == ".Trash" {
		fd, err := unix.Open(filepath.Dir(path), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			return nil, err
		}
		shared = os.NewFile(uintptr(fd), filepath.Dir(path))
		defer shared.Close()
		info, err := shared.Stat()
		if err != nil || info.Mode()&os.ModeSticky == 0 {
			return nil, errors.New("unsafe shared trash directory")
		}
		path = fdPath(shared, filepath.Base(path))
	}
	dir, err := privateTrashDirectory(path, create)
	if err != nil {
		return nil, err
	}
	b := &trashBin{trashLocation: location, dir: dir}
	// Serialize our workers without leaving a private lock file in shared desktop trash.
	lock := unix.LOCK_SH
	if write {
		lock = unix.LOCK_EX
	}
	if err = unix.Flock(int(dir.Fd()), lock|unix.LOCK_NB); err == nil {
		b.files, err = privateTrashDirectory(fdPath(dir, "files"), create)
	}
	if err == nil {
		b.info, err = privateTrashDirectory(fdPath(dir, "info"), create)
	}
	if err != nil {
		b.close()
		return nil, err
	}
	return b, nil
}

func (b *trashBin) close() {
	for _, f := range []*os.File{b.info, b.files, b.dir} {
		if f != nil {
			f.Close()
		}
	}
}

func homeTrash() (trashLocation, error) {
	data := os.Getenv("XDG_DATA_HOME")
	if !filepath.IsAbs(data) {
		home, err := os.UserHomeDir()
		if err != nil {
			return trashLocation{}, err
		}
		data = filepath.Join(home, ".local", "share")
	}
	return trashLocation{path: filepath.Join(data, "Trash")}, nil
}

func trashMounts() ([]string, error) {
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	seen := map[string]bool{}
	var mounts []string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 6 {
			continue
		}
		path := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`).Replace(fields[4])
		if !seen[path] {
			mounts = append(mounts, path)
			seen[path] = true
		}
	}
	return mounts, scanner.Err()
}

func beneath(path, parent string) bool {
	rel, err := filepath.Rel(parent, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func trashMount(path string, mounts []string) string {
	best := "/"
	for _, mount := range mounts {
		if len(mount) > len(best) && beneath(path, mount) {
			best = mount
		}
	}
	return best
}

// Resolve existing ancestors too, since ~/.local/share may not exist yet.
func trashCanonical(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if errors.Is(err, os.ErrNotExist) && path != "/" {
		parent, parentErr := trashCanonical(filepath.Dir(path))
		return filepath.Join(parent, filepath.Base(path)), parentErr
	}
	return resolved, err
}

func volumeTrash(top string) []trashLocation {
	uid := strconv.Itoa(os.Getuid())
	var locations []trashLocation
	shared := filepath.Join(top, ".Trash")
	info, err := os.Lstat(shared)
	if err == nil && info.IsDir() && info.Mode()&os.ModeSticky != 0 {
		locations = append(locations, trashLocation{filepath.Join(shared, uid), top})
	}
	return append(locations, trashLocation{filepath.Join(top, ".Trash-"+uid), top})
}

func openVolumeTrash(top string) (*trashBin, error) {
	locations := volumeTrash(top)
	var err error
	for _, create := range []bool{false, true} {
		for _, location := range locations {
			var bin *trashBin
			bin, err = location.open(create, true)
			if err == nil || errors.Is(err, syscall.EWOULDBLOCK) {
				return bin, err
			}
		}
	}
	return nil, err
}

func trashLocations() ([]trashLocation, error) {
	home, err := homeTrash()
	if err != nil {
		return nil, err
	}
	mounts, err := trashMounts()
	if err != nil {
		return nil, err
	}
	locations := []trashLocation{home}
	for _, top := range mounts {
		for _, location := range volumeTrash(top) {
			if info, err := os.Lstat(location.path); err == nil && info.IsDir() && info.Sys().(*syscall.Stat_t).Uid == uint32(os.Getuid()) && info.Mode().Perm()&0077 == 0 {
				locations = append(locations, location)
			}
		}
	}
	return locations, nil
}

func trashOperation(ctx context.Context, r Request) (Response, error) {
	if r.Operation == "trash" {
		return moveToTrash(ctx, r.Path)
	}
	locations, err := trashLocations()
	if err != nil {
		return Response{}, err
	}
	response := Response{Path: TrashPath, Entries: []Entry{}}
	if r.Operation == "trash-list" || r.Operation == "trash-empty" {
		for _, location := range locations {
			if err := ctx.Err(); err != nil {
				return response, err
			}
			bin, err := location.open(false, r.Operation != "trash-list")
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return response, err
			}
			if r.Operation == "trash-empty" {
				err = bin.empty(ctx)
			} else {
				err = bin.list(ctx, &response)
			}
			bin.close()
			if err != nil {
				return response, err
			}
		}
		sort.Slice(response.Entries, func(i, j int) bool { return response.Entries[i].Name < response.Entries[j].Name })
		return response, nil
	}
	if r.Operation != "trash-restore" && r.Operation != "trash-delete" {
		return response, errors.New("invalid trash operation")
	}
	if !filepath.IsAbs(r.Path) || filepath.Clean(r.Path) != r.Path || strings.ContainsRune(r.Path, 0) {
		return response, errors.New("invalid trash item")
	}
	for _, location := range locations {
		if filepath.Dir(r.Path) != filepath.Join(location.path, "files") {
			continue
		}
		bin, err := location.open(false, true)
		if err != nil {
			return response, err
		}
		defer bin.close()
		if r.Operation == "trash-delete" {
			return response, bin.remove(filepath.Base(r.Path))
		}
		response.Path, err = bin.restore(ctx, filepath.Base(r.Path))
		return response, err
	}
	return response, errors.New("item is not in this user's trash bin")
}

func moveToTrash(ctx context.Context, path string) (Response, error) {
	if !filepath.IsAbs(path) || strings.ContainsRune(path, 0) {
		return Response{}, errors.New("path must be absolute")
	}
	path = filepath.Clean(path)
	parent, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return Response{}, err
	}
	path = filepath.Join(parent, filepath.Base(path))
	if _, err := os.Lstat(path); err != nil {
		return Response{}, err
	}
	mounts, err := trashMounts()
	if err != nil {
		return Response{}, err
	}
	if path == trashMount(path, mounts) {
		return Response{}, errors.New("cannot trash a filesystem root")
	}
	home, err := homeTrash()
	if err != nil {
		return Response{}, err
	}
	homePath, err := trashCanonical(home.path)
	if err != nil {
		return Response{}, err
	}
	for _, location := range append([]trashLocation{{path: homePath}}, volumeTrash(trashMount(parent, mounts))...) {
		if beneath(path, location.path) || beneath(location.path, path) {
			return Response{}, errors.New("cannot move a trash directory or its contents to trash")
		}
	}
	var bin *trashBin
	if trashMount(parent, mounts) == trashMount(homePath, mounts) {
		if err = os.MkdirAll(filepath.Dir(home.path), 0700); err == nil {
			bin, err = home.open(true, true)
		}
	} else {
		bin, err = openVolumeTrash(trashMount(parent, mounts))
	}
	if err != nil {
		return Response{}, fmt.Errorf("cannot move to trash: %w", err)
	}
	defer bin.close()
	name, err := bin.put(ctx, path)
	return Response{Path: filepath.Join(bin.path, "files", name)}, err
}

func (b *trashBin) put(ctx context.Context, path string) (string, error) {
	original := path
	if b.top != "" {
		original, _ = filepath.Rel(b.top, path)
	}
	content := "[Trash Info]\nPath=" + (&url.URL{Path: original}).EscapedPath() + "\nDeletionDate=" + time.Now().Format("2006-01-02T15:04:05") + "\n"
	base := filepath.Base(path)
	if len(base) > 200 {
		base = base[:200]
	}
	for n := 0; n < 10000; n++ {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		name := base
		if n != 0 {
			name += "." + strconv.Itoa(n)
		}
		if _, err := os.Lstat(fdPath(b.files, name)); !errors.Is(err, os.ErrNotExist) {
			if err != nil {
				return "", err
			}
			continue
		}
		infoPath := fdPath(b.info, name+".trashinfo")
		f, err := os.OpenFile(infoPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		_, err = io.WriteString(f, content)
		if err == nil {
			err = f.Sync()
		}
		closeErr := f.Close()
		if err == nil {
			err = closeErr
		}
		if err == nil {
			err = b.info.Sync()
		}
		if err == nil {
			err = ctx.Err()
		}
		if err == nil {
			err = unix.Renameat2(unix.AT_FDCWD, path, int(b.files.Fd()), name, unix.RENAME_NOREPLACE)
		}
		if err != nil {
			_ = os.Remove(infoPath)
			return "", err
		}
		return name, nil
	}
	return "", errors.New("too many trash name collisions")
}

func (b *trashBin) original(name string) (string, string, error) {
	fd, err := unix.Openat(int(b.info.Fd()), name+".trashinfo", unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return "", "", err
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 64<<10 {
		return "", "", errors.New("invalid trash metadata")
	}
	scanner := bufio.NewScanner(io.LimitReader(f, 64<<10))
	var path, deleted string
	group := ""
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if strings.HasPrefix(line, "[") {
			group = line
		}
		if group != "[Trash Info]" {
			continue
		}
		if value, ok := strings.CutPrefix(line, "Path="); ok {
			if path != "" {
				return "", "", errors.New("duplicate trash path")
			}
			path, err = url.PathUnescape(value)
			if err != nil {
				return "", "", err
			}
		}
		if value, ok := strings.CutPrefix(line, "DeletionDate="); ok {
			deleted = value
		}
	}
	if err := scanner.Err(); err != nil {
		return "", "", err
	}
	if path == "" || strings.ContainsRune(path, 0) || filepath.Clean(path) != path {
		return "", "", errors.New("invalid original trash path")
	}
	if !filepath.IsAbs(path) {
		if b.top == "" || path == "." || path == ".." || strings.HasPrefix(path, "../") {
			return "", "", errors.New("invalid relative trash path")
		}
		path = filepath.Join(b.top, path)
	}
	if path == "/" || beneath(path, b.path) || beneath(b.path, path) {
		return "", "", errors.New("invalid original trash location")
	}
	return path, deleted, nil
}

func (b *trashBin) list(ctx context.Context, response *Response) error {
	entries, err := b.files.ReadDir(10001 - len(response.Entries))
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if len(response.Entries) == 10000 {
			response.Truncated = true
			break
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		value := metadata(fdPath(b.files, entry.Name()), info)
		value.Path = filepath.Join(b.path, "files", entry.Name())
		value.OriginalPath, value.Deleted, _ = b.original(entry.Name())
		if value.OriginalPath != "" {
			value.Name = filepath.Base(value.OriginalPath)
		}
		response.Entries = append(response.Entries, value)
	}
	return nil
}

func (b *trashBin) restore(ctx context.Context, name string) (string, error) {
	path, _, err := b.original(name)
	if err != nil {
		return "", fmt.Errorf("cannot restore: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := unix.Renameat2(int(b.files.Fd()), name, unix.AT_FDCWD, path, unix.RENAME_NOREPLACE); err != nil {
		return "", fmt.Errorf("cannot restore %s: %w", path, err)
	}
	if err := os.Remove(fdPath(b.info, name+".trashinfo")); err != nil {
		return path, fmt.Errorf("restored %s, but metadata cleanup failed: %w", path, err)
	}
	return path, nil
}

func (b *trashBin) remove(name string) error {
	if err := os.RemoveAll(fdPath(b.files, name)); err != nil {
		return err
	}
	err := os.Remove(fdPath(b.info, name+".trashinfo"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (b *trashBin) empty(ctx context.Context) error {
	for {
		entries, err := b.files.ReadDir(128)
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := b.remove(entry.Name()); err != nil {
				return err
			}
		}
		if len(entries) == 0 {
			return nil
		}
	}
}
