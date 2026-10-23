package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
	"tuxee/internal/service"
)

const runtimeDirectory = "/run/tuxee"

type runtimeRecord struct {
	Protocol   int    `json:"protocol"`
	PID        int    `json:"pid"`
	Start      string `json:"start"`
	Boot       string `json:"boot"`
	Executable string `json:"executable"`
	State      string `json:"state"`
}

func processStart(dir *os.File) (string, error) {
	fd, err := unix.Openat(int(dir.Fd()), "stat", unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return "", err
	}
	f := os.NewFile(uintptr(fd), "stat")
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 4096))
	if err != nil {
		return "", err
	}
	end := strings.LastIndexByte(string(data), ')')
	if end < 0 {
		return "", errors.New("invalid process identity")
	}
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) < 20 || fields[0] == "Z" {
		return "", errors.New("process is unavailable")
	}
	return fields[19], nil
}

func checkRuntimeDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode().Perm()&0022 != 0 || info.Sys().(*syscall.Stat_t).Uid != 0 {
		return errors.New("unsafe runtime directory " + path)
	}
	return nil
}

// Publish only after the restart signal handler is installed; old servers have no record.
func registerRuntime(directory, state string) (func(), error) {
	if err := os.MkdirAll(directory, 0755); err != nil {
		return nil, err
	}
	if err := checkRuntimeDirectory(directory); err != nil {
		return nil, err
	}
	if err := os.Chmod(directory, 0755); err != nil {
		return nil, err
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return nil, err
	}
	state, err = filepath.EvalSymlinks(state)
	if err != nil {
		return nil, err
	}
	proc, err := os.Open("/proc/self")
	if err != nil {
		return nil, err
	}
	defer proc.Close()
	start, err := processStart(proc)
	if err != nil {
		return nil, err
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return nil, err
	}
	record := runtimeRecord{1, os.Getpid(), start, string(boot), executable, state}
	f, err := os.CreateTemp(directory, ".runtime-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err := json.NewEncoder(f).Encode(record); err != nil {
		return nil, err
	}
	if err := f.Chmod(0644); err != nil {
		return nil, err
	}
	path := filepath.Join(directory, strconv.Itoa(record.PID)+".json")
	if err := os.Rename(f.Name(), path); err != nil {
		return nil, err
	}
	return func() { _ = os.Remove(path) }, nil
}

func findRuntime(directory, executable, state string) (*os.File, error) {
	missing := errors.New("no running Tuxee instance found for this installation; older versions need the UI restart or a service/supervisor restart once")
	if err := checkRuntimeDirectory(directory); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, missing
		}
		return nil, err
	}
	executable, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return nil, err
	}
	if state != "" {
		state, err = filepath.EvalSymlinks(state)
		if err != nil {
			return nil, err
		}
		state, err = filepath.Abs(state)
		if err != nil {
			return nil, err
		}
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	var found *os.File
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		info, err := entry.Info()
		if err != nil || info.Mode().Perm()&0022 != 0 || info.Sys().(*syscall.Stat_t).Uid != 0 {
			continue
		}
		data, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		var record runtimeRecord
		if err != nil || json.Unmarshal(data, &record) != nil || record.Protocol != 1 || record.PID < 1 || record.Boot != string(boot) || record.Executable != executable || (state != "" && record.State != state) {
			continue
		}
		proc, err := os.Open(fmt.Sprintf("/proc/%d", record.PID))
		if err != nil {
			continue
		}
		start, err := processStart(proc)
		if err != nil || start != record.Start {
			proc.Close()
			continue
		}
		if found != nil {
			found.Close()
			proc.Close()
			return nil, errors.New("multiple Tuxee instances use this installation; select one with --state directory")
		}
		found = proc
	}
	if found == nil {
		return nil, missing
	}
	return found, nil
}

func runRestart(args []string) (err error) {
	defer func() {
		if err != nil && !errors.Is(err, flag.ErrHelp) {
			fmt.Fprintln(os.Stderr, "\n"+colored(os.Stderr, "31", "Restart failed: "+err.Error()))
			err = reportedError{err}
		}
	}()
	f := flag.NewFlagSet("restart", flag.ContinueOnError)
	name := f.String("name", "", "restart this named managed service's runtime")
	state := f.String("state", "", "select an instance by its state directory")
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("unexpected restart arguments")
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	if *name != "" {
		executable, err = service.Executable(*name)
		if err != nil {
			return err
		}
	}
	proc, err := findRuntime(runtimeDirectory, executable, *state)
	if err != nil {
		return err
	}
	defer proc.Close()
	// Use the pinned proc descriptor for both permission checking and signalling.
	if err := unix.PidfdSendSignal(int(proc.Fd()), 0, nil, 0); err != nil {
		return err
	}
	fmt.Println("\nRestarting Tuxee kills all running terminals and GUI applications and signs everyone out.")
	if err := unix.PidfdSendSignal(int(proc.Fd()), unix.SIGUSR1, nil, 0); err != nil {
		return err
	}
	fmt.Println("\n" + colored(os.Stdout, "32", "Restart requested."))
	return nil
}
