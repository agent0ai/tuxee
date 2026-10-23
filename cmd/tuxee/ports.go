package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

func runPorts(args []string, output io.Writer) error {
	f := flag.NewFlagSet("ports", flag.ContinueOnError)
	path := f.String("config", "/etc/tuxee/config.json", "existing JSON configuration to show or edit")
	var httpPort, httpsPort *int
	for _, port := range []struct {
		name  string
		value **int
	}{{"http-port", &httpPort}, {"https-port", &httpsPort}} {
		f.Func(port.name, "save listening port (0 disables); restart Tuxee to apply", func(raw string) error {
			n, err := parsePort(raw)
			if err == nil {
				*port.value = &n
			}
			return err
		})
	}
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("unexpected ports arguments")
	}
	info, err := os.Lstat(*path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("configuration must be a regular file, not a symlink")
	}
	value, err := loadConfig(*path)
	if err != nil {
		return err
	}
	if httpPort != nil {
		value.HTTPPort = httpPort
	}
	if httpsPort != nil {
		value.HTTPSPort = httpsPort
	}
	if err := value.validate(); err != nil {
		return err
	}
	listeners, err := value.listeners()
	if err != nil {
		return err
	}
	if httpPort != nil || httpsPort != nil {
		if len(listeners) == 0 {
			return errors.New("HTTP and HTTPS cannot both be disabled; leave at least one listener enabled")
		}
		staged, err := os.CreateTemp(filepath.Dir(*path), ".tuxee-config-*")
		if err != nil {
			return err
		}
		defer os.Remove(staged.Name())
		defer staged.Close()
		encoder := json.NewEncoder(staged)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(value); err != nil {
			return err
		}
		owner := info.Sys().(*syscall.Stat_t)
		if err := staged.Chown(int(owner.Uid), int(owner.Gid)); err != nil {
			return err
		}
		if err := staged.Chmod(info.Mode().Perm()); err != nil {
			return err
		}
		if err := staged.Sync(); err != nil {
			return err
		}
		if err := staged.Close(); err != nil {
			return err
		}
		if err := os.Rename(staged.Name(), *path); err != nil {
			return err
		}
		fmt.Fprintln(output, "Saved. Restart Tuxee to apply; restarting ends active terminals and login sessions.")
	}
	httpAddress, httpsAddress := "disabled", "disabled"
	for _, listener := range listeners {
		if listener.https {
			httpsAddress = listener.address
		} else {
			httpAddress = listener.address
		}
	}
	fmt.Fprintf(output, "Saved listeners in %s:\n  HTTP: %s\n  HTTPS: %s\n", *path, httpAddress, httpsAddress)
	fmt.Fprintln(output, "Startup flags and TUXEE_HTTP_PORT/TUXEE_HTTPS_PORT override these saved settings.")
	return nil
}
