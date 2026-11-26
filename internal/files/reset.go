package files

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// ResetBackupDirectory is the home-relative folder that receives configuration reset backups.
const ResetBackupDirectory = "tuxee-backups"

// ResetBackup describes one reset backup so people and agents can restore it.
type ResetBackup struct {
	Created string `json:"created"`
	Config  string `json:"config"`
	State   string `json:"state"`
}

// resetConfiguration moves this account's Tuxee configuration and state into a new backup
// folder under the worker's credentials. Folders locked by a live terminal guardian stay in
// place because moving them would hide running processes from their installation.
func resetConfiguration(ctx context.Context) (Response, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Response{}, err
	}
	config := filepath.Join(home, ".config", "tuxee")
	state, err := stateDirectory("")
	if err != nil {
		return Response{}, err
	}
	state = filepath.Clean(state)
	backup, err := createResetBackup(home)
	if err != nil {
		return Response{}, err
	}
	response := Response{Path: backup}
	if err = backupConfiguration(ctx, config, filepath.Join(backup, "config")); err != nil {
		return response, err
	}
	if err = moveTree(ctx, state, filepath.Join(backup, "state"), true); err != nil {
		return response, err
	}
	data, _ := json.MarshalIndent(ResetBackup{Created: time.Now().UTC().Format(time.RFC3339), Config: config, State: state}, "", "  ")
	if err = os.WriteFile(filepath.Join(backup, "backup.json"), append(data, '\n'), 0600); err != nil {
		return response, err
	}
	// Broadcast notices require an existing configuration folder.
	return response, os.MkdirAll(config, 0700)
}

// Authentication survives a settings reset; only explicit security recovery clears it.
func backupConfiguration(ctx context.Context, source, destination string) error {
	entries, err := os.ReadDir(source)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return os.ErrPermission
	}
	if err = os.Mkdir(destination, 0700); err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == "security" {
			continue
		}
		if err = movePath(ctx, filepath.Join(source, entry.Name()), filepath.Join(destination, entry.Name())); err != nil {
			return err
		}
	}
	return os.Chmod(source, 0700)
}

func createResetBackup(home string) (string, error) {
	base := filepath.Join(home, ResetBackupDirectory)
	if err := os.MkdirAll(base, 0700); err != nil {
		return "", err
	}
	if info, err := os.Lstat(base); err != nil || !info.IsDir() || info.Sys().(*syscall.Stat_t).Uid != uint32(os.Geteuid()) {
		if err == nil {
			err = os.ErrPermission
		}
		return "", err
	}
	stamp := time.Now().UTC().Format("2006-01-02_15-04-05")
	for index := 1; index < 1000; index++ {
		name := stamp
		if index > 1 {
			name = fmt.Sprintf("%s_%d", stamp, index)
		}
		path := filepath.Join(base, name)
		if err := os.Mkdir(path, 0700); err == nil {
			return path, nil
		} else if !errors.Is(err, os.ErrExist) {
			return "", err
		}
	}
	return "", os.ErrExist
}

// moveTree renames source to destination, or with keepLocked moves entries one by one and
// descends into terminals so guardian-locked folders remain where their guardians expect them.
func moveTree(ctx context.Context, source, destination string, keepLocked bool) error {
	info, err := os.Lstat(source)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || !keepLocked {
		return movePath(ctx, source, destination)
	}
	entries, err := os.ReadDir(source)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(destination, 0700); err != nil {
		return err
	}
	for _, entry := range entries {
		from, to := filepath.Join(source, entry.Name()), filepath.Join(destination, entry.Name())
		if entry.Name() == "terminals" && entry.IsDir() {
			if err = moveUnlocked(ctx, from, to); err != nil {
				return err
			}
			continue
		}
		if err = movePath(ctx, from, to); err != nil {
			return err
		}
	}
	return nil
}

func moveUnlocked(ctx context.Context, source, destination string) error {
	entries, err := os.ReadDir(source)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(destination, 0700); err != nil {
		return err
	}
	for _, entry := range entries {
		from := filepath.Join(source, entry.Name())
		if entry.IsDir() {
			lock, err := lockTerminalDirectory(from)
			if err != nil {
				// A running guardian owns this folder.
				continue
			}
			err = movePath(ctx, from, filepath.Join(destination, entry.Name()))
			lock.Close()
			if err != nil {
				return err
			}
			continue
		}
		if err = movePath(ctx, from, filepath.Join(destination, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

// movePath renames within a filesystem and copies then removes across filesystems.
func movePath(ctx context.Context, source, destination string) error {
	err := os.Rename(source, destination)
	if !errors.Is(err, syscall.EXDEV) {
		return err
	}
	if err = copyTree(ctx, source, destination); err != nil {
		return err
	}
	return os.RemoveAll(source)
}
