package files

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// ValidateDownload checks the selection only; filesystem access belongs to the worker.
func ValidateDownload(r Request) error {
	if !filepath.IsAbs(r.Path) || strings.ContainsRune(r.Path, 0) || len(r.Paths) == 0 || len(r.Paths) > 10000 {
		return errors.New("select files or folders to download")
	}
	seen := make(map[string]bool, len(r.Paths))
	for _, path := range r.Paths {
		if !filepath.IsAbs(path) || strings.ContainsRune(path, 0) || filepath.Dir(filepath.Clean(path)) != filepath.Clean(r.Path) || filepath.Clean(path) == filepath.Clean(r.Path) || seen[filepath.Clean(path)] {
			return errors.New("download sources must be distinct items in the selected directory")
		}
		seen[filepath.Clean(path)] = true
	}
	return nil
}

func downloadZIP(ctx context.Context, r Request, output io.Writer) error {
	if err := ValidateDownload(r); err != nil {
		return err
	}
	root, err := os.OpenRoot(r.Path)
	if err != nil {
		return err
	}
	defer root.Close()
	archive := zip.NewWriter(output)
	for _, path := range r.Paths {
		if err := zipEntry(ctx, archive, root, filepath.Base(filepath.Clean(path))); err != nil {
			// Do not finalize a partial archive: the HTTP stream must fail.
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return archive.Close()
}

func zipEntry(ctx context.Context, archive *zip.Writer, root *os.Root, name string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	info, err := root.Lstat(name)
	if err != nil {
		return err
	}
	var file *os.File
	if info.Mode()&os.ModeSymlink == 0 {
		if !info.IsDir() && !info.Mode().IsRegular() {
			return errors.New("ZIP downloads support regular files, folders and symlinks")
		}
		// Verify the opened inode and avoid blocking on a replaced FIFO.
		file, err = root.OpenFile(name, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
		if err != nil {
			return err
		}
		defer file.Close()
		opened, err := file.Stat()
		if err != nil {
			return err
		}
		if !os.SameFile(info, opened) {
			return errors.New("file changed during ZIP download")
		}
		info = opened
	}
	header, err := zip.FileInfoHeader(info)
	if err != nil {
		return err
	}
	header.Name = filepath.ToSlash(name)
	header.SetMode(info.Mode() &^ (os.ModeSetuid | os.ModeSetgid | os.ModeSticky))
	if info.IsDir() {
		header.Name += "/"
	} else if info.Mode().IsRegular() {
		header.Method = zip.Deflate
	}
	entry, err := archive.CreateHeader(header)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := root.Readlink(name)
		if err != nil {
			return err
		}
		_, err = io.WriteString(entry, target)
		return err
	}
	if !info.IsDir() {
		_, err = io.Copy(entry, &contextReader{ctx, file})
		return err
	}
	for {
		children, err := file.ReadDir(256)
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		for _, child := range children {
			if err := zipEntry(ctx, archive, root, filepath.Join(name, child.Name())); err != nil {
				return err
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
	}
}

func streamZIP(ctx context.Context, r Request, output io.Writer) error {
	if err := ValidateDownload(r); err != nil {
		return json.NewEncoder(output).Encode(Response{Error: err.Error()})
	}
	if err := json.NewEncoder(output).Encode(Response{}); err != nil {
		return err
	}
	return downloadZIP(ctx, r, output)
}
