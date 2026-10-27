package files

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"tuxee/internal/i18n"

	"golang.org/x/sys/unix"
)

type ArchiveFormat struct {
	Name     string `json:"name"`
	Password bool   `json:"password"`
}

func sevenZip() string {
	for _, tool := range []string{"7zz", "7z"} {
		if path, err := exec.LookPath(tool); err == nil {
			return path
		}
	}
	return ""
}
func archiveFormats() []ArchiveFormat {
	result := []ArchiveFormat{}
	if _, err := exec.LookPath("tar"); err == nil {
		result = append(result, ArchiveFormat{"tar", false})
		for _, format := range []struct{ name, tool string }{{"tar.gz", "gzip"}, {"tar.bz2", "bzip2"}, {"tar.xz", "xz"}} {
			if _, err := exec.LookPath(format.tool); err == nil {
				result = append(result, ArchiveFormat{format.name, false})
			}
		}
	}
	if sevenZip() != "" {
		result = append(result, ArchiveFormat{"zip", true}, ArchiveFormat{"7z", true})
	}
	return result
}

// The tools run in the already credential-dropped worker. Passwords never enter argv or the environment.
func archiveCommand(ctx context.Context, directory, password, tool string, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, tool, args...)
	cmd.Dir = directory
	cmd.Env = append(os.Environ(), "LC_ALL=C.UTF-8")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second
	if password != "" {
		cmd.Stdin = strings.NewReader(password + "\n")
	}
	var output boundedOutput
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		message := output.String()
		if message == "" {
			message = err.Error()
		}
		if password != "" {
			message = strings.ReplaceAll(message, password, "[redacted]")
		}
		return i18n.New("backend.files.archiveOperationFailed", i18n.Vars{"value": strings.TrimSpace(message)})
	}
	return nil
}

type boundedOutput struct{ bytes.Buffer }

func (b *boundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	if b.Len() < 16<<10 {
		end := min(len(p), (16<<10)-b.Len())
		_, _ = b.Buffer.Write(p[:end])
	}
	return n, nil
}
func archive(ctx context.Context, r Request) error {
	if !filepath.IsAbs(r.Destination) || strings.ContainsRune(r.Destination, 0) {
		return i18n.New("backend.files.destinationMustBeAbsolute")
	}
	if len(r.Password) > 1024 || strings.ContainsAny(r.Password, "\r\n\x00") {
		return i18n.New("backend.files.invalidArchivePassword")
	}
	if _, err := os.Lstat(r.Destination); err == nil {
		return i18n.New("backend.files.destinationAlreadyExists")
	} else if !os.IsNotExist(err) {
		return err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(r.Destination))
	if err != nil {
		return err
	}
	stage, err := os.MkdirTemp(parent, ".tuxee-archive-*")
	if err != nil {
		return err
	}
	defer removeStaging(stage)
	output := filepath.Join(stage, "contents")
	if r.Operation == "compress" {
		output += "." + r.Format
		if len(r.Paths) == 0 || len(r.Paths) > 10000 {
			return i18n.New("backend.files.selectFilesToCompress")
		}
		names := []string{}
		for _, path := range r.Paths {
			if !filepath.IsAbs(path) || strings.ContainsRune(path, 0) || filepath.Dir(filepath.Clean(path)) != r.Path {
				return i18n.New("backend.files.archiveSourcesMustBeInTheSelectedDirectory")
			}
			info, err := os.Lstat(path)
			if err != nil {
				return err
			}
			if info.IsDir() {
				real, err := filepath.EvalSymlinks(path)
				if err != nil {
					return err
				}
				relative, _ := filepath.Rel(real, parent)
				if relative == "." || relative != ".." && !strings.HasPrefix(relative, "../") {
					return i18n.New("backend.files.archiveDestinationCannotBeInsideASourceDirectory")
				}
			}
			names = append(names, "./"+filepath.Base(path))
		}
		if r.Format == "zip" || r.Format == "7z" {
			tool := sevenZip()
			if tool == "" {
				return i18n.New("backend.files.install7zipForZIP7zArchivesAndPasswords")
			}
			args := []string{"a", "-t" + r.Format, "-y", "-bd", "-sse", "-snl", "-spd"}
			if r.Password != "" {
				args = append(args, "-p")
				if r.Format == "7z" {
					args = append(args, "-mhe=on")
				} else {
					args = append(args, "-mem=AES256")
				}
			}
			args = append(args, output, "--")
			args = append(args, names...)
			if err = archiveCommand(ctx, r.Path, r.Password, tool, args...); err != nil {
				return err
			}
		} else {
			if r.Password != "" {
				return i18n.New("backend.files.passwordsRequireZIPOr7z")
			}
			flag, ok := map[string]string{"tar": "", "tar.gz": "--gzip", "tar.bz2": "--bzip2", "tar.xz": "--xz"}[r.Format]
			if !ok {
				return i18n.New("backend.files.unsupportedArchiveFormat")
			}
			args := []string{"--create", "--file", output}
			if flag != "" {
				args = append(args, flag)
			}
			args = append(args, "--")
			args = append(args, names...)
			if err = archiveCommand(ctx, r.Path, "", "tar", args...); err != nil {
				return err
			}
		}
	} else {
		if err = os.Mkdir(output, 0700); err != nil {
			return err
		}
		lower := strings.ToLower(r.Path)
		tar := false
		for _, ext := range []string{".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz"} {
			tar = tar || strings.HasSuffix(lower, ext)
		}
		if tar {
			if r.Password != "" {
				return i18n.New("backend.files.tarArchivesDoNotSupportPasswords")
			}
			err = archiveCommand(ctx, output, "", "tar", "--extract", "--file", r.Path, "--no-same-owner", "--no-same-permissions", "--keep-old-files")
		} else if tool := sevenZip(); tool != "" {
			err = archiveCommand(ctx, output, r.Password, tool, "x", "-y", "-bd", "-spd", "-o"+output, "--", r.Path)
		} else {
			return i18n.New("backend.files.install7zipToExtractThisArchive")
		}
		if err != nil {
			return err
		}
		// Keep extracted special files and privileged permission bits out of the published tree.
		err = filepath.WalkDir(output, func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if info.Mode()&os.ModeSymlink != 0 {
				target, err := os.Readlink(path)
				if err != nil {
					return err
				}
				resolved := filepath.Clean(filepath.Join(filepath.Dir(path), target))
				if filepath.IsAbs(target) || !strings.HasPrefix(resolved, output+string(os.PathSeparator)) && resolved != output {
					return i18n.New("backend.files.archiveHasALinkOutsideItsDestination")
				}
				return nil
			}
			if !info.Mode().IsRegular() && !info.IsDir() {
				return i18n.New("backend.files.archiveContainsASpecialFile")
			}
			return os.Chmod(path, info.Mode().Perm())
		})
		if err != nil {
			return err
		}
	}
	return unix.Renameat2(unix.AT_FDCWD, output, unix.AT_FDCWD, r.Destination, unix.RENAME_NOREPLACE)
}
