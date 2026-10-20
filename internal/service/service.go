package service

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

const marker = "# Managed by Tuxee service install; format 1\n"

var namePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)

func ValidateName(name string) error {
	if !namePattern.MatchString(name) {
		return errors.New("service name must contain 1–64 letters, digits, underscores or hyphens")
	}
	return nil
}
func Available() error {
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return errors.New("systemd is not running here; use 'tuxee serve' in the foreground or the Docker example")
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		return errors.New("systemctl is unavailable; use 'tuxee serve'")
	}
	return nil
}
func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}
func Lifecycle(action, name string) error {
	if err := ValidateName(name); err != nil {
		return err
	}
	if err := Available(); err != nil {
		return err
	}
	if action == "logs" {
		return run("journalctl", "--unit", name+".service", "--follow", "--lines", "100")
	}
	switch action {
	case "start", "stop", "restart", "status":
	default:
		return errors.New("unknown service action")
	}
	return run("systemctl", action, "--no-pager", name+".service")
}

type paths struct{ unit, binary, config string }

func locations(name string) paths {
	return paths{filepath.Join("/etc/systemd/system", name+".service"), filepath.Join("/usr/local/lib", name, "tuxee"), filepath.Join("/etc", name, "config.json")}
}

func Install(name, state string, config []byte) error {
	if os.Geteuid() != 0 {
		return errors.New("service installation requires root")
	}
	if err := ValidateName(name); err != nil {
		return err
	}
	if err := Available(); err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	p := locations(name)
	if err = installFiles(p, executable, state, config); err != nil {
		return err
	}
	if err = run("systemctl", "daemon-reload"); err != nil {
		return err
	}
	if err = run("systemctl", "enable", name+".service"); err != nil {
		return err
	}
	active := exec.Command("systemctl", "is-active", "--quiet", name+".service").Run() == nil
	fmt.Printf("Installed %s.service; enabled at boot. Configuration: %s\n", name, p.config)
	if active {
		fmt.Printf("Service is running; apply changes with tuxee restart --name %s\n", name)
	} else {
		fmt.Printf("Service is stopped; start it with tuxee start --name %s\n", name)
	}
	return nil
}

func managedUnit(path string) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() {
		return false, errors.New("refusing to replace a non-regular service unit")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	if !bytes.HasPrefix(data, []byte(marker)) {
		return false, errors.New("refusing to change an unrelated service unit")
	}
	return true, nil
}
func protectedDirectory(path string, mode os.FileMode) error {
	if err := os.MkdirAll(path, mode); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("installation directory must be a real directory")
	}
	return os.Chmod(path, mode)
}
func installFiles(p paths, executable, state string, config []byte) error {
	owned, err := managedUnit(p.unit)
	if err != nil {
		return err
	}
	if !filepath.IsAbs(state) {
		return errors.New("state directory must be absolute")
	}
	if !owned {
		if _, err := os.Lstat(p.binary); !errors.Is(err, os.ErrNotExist) {
			previous, readErr := os.ReadFile(filepath.Join(filepath.Dir(p.binary), ".tuxee-install"))
			if readErr != nil || string(previous) != marker {
				return errors.New("refusing to replace an executable without a managed installation")
			}
		}
	}
	for _, path := range []string{filepath.Dir(p.binary), filepath.Dir(p.config), state} {
		mode := os.FileMode(0700)
		if path == filepath.Dir(p.binary) {
			mode = 0755
		}
		if err := protectedDirectory(path, mode); err != nil {
			return err
		}
	}
	if info, err := os.Lstat(p.config); errors.Is(err, os.ErrNotExist) {
		if err = atomicWrite(p.config, bytes.NewReader(config), 0600); err != nil {
			return err
		}
	} else if err != nil {
		return err
	} else if !info.Mode().IsRegular() {
		return errors.New("configuration must be a regular file")
	}
	input, err := os.Open(executable)
	if err != nil {
		return err
	}
	defer input.Close()
	if err = atomicWrite(p.binary, input, 0755); err != nil {
		return err
	}
	if err = atomicWrite(filepath.Join(filepath.Dir(p.binary), ".tuxee-install"), strings.NewReader(marker), 0600); err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(p.unit), 0755); err != nil {
		return err
	}
	return atomicWrite(p.unit, strings.NewReader(unit(p)), 0644)
}
func atomicWrite(path string, data io.Reader, mode os.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".tuxee-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(mode); err == nil {
		_, err = io.Copy(f, data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}
func quote(value string) string {
	value = strings.ReplaceAll(value, "\\", "\\\\")
	value = strings.ReplaceAll(value, "\"", "\\\"")
	value = strings.ReplaceAll(value, "%", "%%")
	value = strings.ReplaceAll(value, "\n", "\\n")
	value = strings.ReplaceAll(value, "\r", "\\r")
	return "\"" + value + "\""
}
func unit(p paths) string {
	commandQuote := func(value string) string { return strings.ReplaceAll(quote(value), "$", "$$") }
	return marker + "[Unit]\nDescription=Tuxee Linux management\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=root\nUMask=0077\nExecStart=" + commandQuote(p.binary) + " serve --config " + commandQuote(p.config) + "\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nKillMode=control-group\n\n[Install]\nWantedBy=multi-user.target\n"
}
func Uninstall(name string) error {
	if os.Geteuid() != 0 {
		return errors.New("service removal requires root")
	}
	if err := ValidateName(name); err != nil {
		return err
	}
	if err := Available(); err != nil {
		return err
	}
	p := locations(name)
	owned, err := managedUnit(p.unit)
	if err != nil {
		return err
	}
	if !owned {
		fmt.Println("Service is already unregistered.")
		return nil
	}
	if err = run("systemctl", "disable", "--now", name+".service"); err != nil {
		return err
	}
	if err = os.Remove(p.unit); err != nil {
		return err
	}
	if err = run("systemctl", "daemon-reload"); err != nil {
		return err
	}
	fmt.Printf("Unregistered %s.service. Binary, configuration, user files and certificate state were preserved.\n", name)
	return nil
}
