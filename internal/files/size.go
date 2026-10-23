package files

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

type SizeProgress struct {
	Size    int64 `json:"size"`
	Skipped int   `json:"skipped"`
	Done    bool  `json:"done"`
}

func streamSize(ctx context.Context, paths []string, output io.Writer) error {
	encoder := json.NewEncoder(output)
	if len(paths) == 0 || len(paths) > 10000 {
		return encoder.Encode(Response{Error: "select between 1 and 10,000 paths"})
	}
	for i, path := range paths {
		if !filepath.IsAbs(path) || strings.ContainsRune(path, 0) {
			return encoder.Encode(Response{Error: "paths must be absolute and contain no NUL"})
		}
		paths[i] = filepath.Clean(path)
	}
	if err := encoder.Encode(Response{}); err != nil {
		return err
	}
	// Linux scheduling priorities belong to the thread doing the filesystem work.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	_ = unix.Setpriority(unix.PRIO_PROCESS, 0, 19)
	_, _, _ = unix.Syscall(unix.SYS_IOPRIO_SET, 1, 0, 3<<13) // Best-effort idle I/O class.
	return calculateSize(ctx, paths, func(progress SizeProgress) error { return encoder.Encode(progress) })
}

func calculateSize(ctx context.Context, paths []string, emit func(SizeProgress) error) error {
	var progress SizeProgress
	last := time.Now()
	if err := emit(progress); err != nil {
		return err
	}
	steps := 0
	checkpoint := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		steps++
		if steps%128 == 0 {
			timer := time.NewTimer(10 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
		}
		if time.Since(last) >= 500*time.Millisecond {
			if err := emit(progress); err != nil {
				return err
			}
			last = time.Now()
		}
		return nil
	}
	type identity struct{ device, inode uint64 }
	ancestors := make(map[identity]bool)
	var visit func(int, string, int) error
	visit = func(parent int, name string, depth int) error {
		if err := checkpoint(); err != nil {
			return err
		}
		var stat unix.Stat_t
		if err := unix.Fstatat(parent, name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			progress.Skipped++
			return nil
		}
		if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
			progress.Size += max(0, stat.Size)
			return nil
		}
		// Bound open descriptors and stop bind-mount cycles without retaining every entry.
		id := identity{uint64(stat.Dev), stat.Ino}
		if depth >= 128 || ancestors[id] {
			progress.Skipped++
			return nil
		}
		fd, err := unix.Openat(parent, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
		if err != nil {
			progress.Skipped++
			return nil
		}
		dir := os.NewFile(uintptr(fd), name)
		defer dir.Close()
		// Check the opened inode too: a directory can be replaced between stat and open.
		if err = unix.Fstat(fd, &stat); err != nil {
			progress.Skipped++
			return nil
		}
		id = identity{uint64(stat.Dev), stat.Ino}
		if ancestors[id] {
			progress.Skipped++
			return nil
		}
		ancestors[id] = true
		defer delete(ancestors, id)
		for {
			names, err := dir.Readdirnames(128)
			for _, child := range names {
				if err := visit(fd, child, depth+1); err != nil {
					return err
				}
			}
			if err != nil {
				if !errors.Is(err, io.EOF) {
					progress.Skipped++
				}
				return ctx.Err()
			}
		}
	}
	// Selected descendants are already included by a selected real directory.
	sort.Strings(paths)
	selected := make(map[string]bool, len(paths))
	for _, path := range paths {
		if _, exists := selected[path]; exists {
			continue
		}
		covered := false
		for parent := filepath.Dir(path); parent != path; parent = filepath.Dir(parent) {
			if selected[parent] {
				covered = true
				break
			}
			if parent == "/" {
				break
			}
		}
		if covered {
			continue
		}
		info, err := os.Lstat(path)
		selected[path] = err == nil && info.IsDir()
		if err := visit(unix.AT_FDCWD, path, 0); err != nil {
			return err
		}
	}
	progress.Done = true
	return emit(progress)
}
