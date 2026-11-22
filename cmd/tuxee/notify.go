package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"tuxee/internal/files"
	"tuxee/internal/identity"
)

func runNotify(args []string) error {
	flags := flag.NewFlagSet("notify", flag.ContinueOnError)
	users := flags.String("users", "", "comma-separated Linux usernames")
	all := flags.Bool("users-all", false, "all Linux users with existing Tuxee folders")
	name := flags.String("name", "", "select a named managed installation")
	state := flags.String("state", "", "select an instance by its state directory")
	kind := flags.String("type", "default", "default, info, success, warning or error")
	text := flags.String("text", "", "notification text (Markdown)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || (*users != "") == *all {
		return errors.New("specify exactly one of --users or --users-all")
	}
	notification := files.Notification{Type: *kind, Text: *text}
	if !notification.Valid() {
		return errors.New("provide non-empty UTF-8 --text (up to 8192 bytes) and a valid --type")
	}
	proc, _, err := selectRuntime(*name, *state)
	if err == nil {
		defer proc.Close()
		if err := checkRuntimeSignal(proc); err != nil {
			return fmt.Errorf("permission to signal the Tuxee runtime: %w", err)
		}
	} else if !errors.Is(err, errRuntimeNotFound) || *name != "" || *state != "" {
		return err
	}
	// With no running instance, offline delivery still requires the recipient's Linux credentials.
	names := strings.Split(*users, ",")
	if !*all {
		for _, name := range names {
			if strings.TrimSpace(name) == "" {
				return errors.New("--users contains an empty username")
			}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	return postNotifications(ctx, names, *all, notification)
}

func postNotifications(ctx context.Context, names []string, all bool, notification files.Notification) error {
	if all {
		accounts, err := exec.CommandContext(ctx, "/usr/bin/getent", "passwd").Output()
		if err != nil {
			return err
		}
		names = nil
		for line := range strings.SplitSeq(string(accounts), "\n") {
			fields := strings.Split(line, ":")
			if len(fields) != 7 || !filepath.IsAbs(fields[5]) {
				continue
			}
			if _, err := os.Stat(filepath.Join(fields[5], ".config", "tuxee")); !errors.Is(err, os.ErrNotExist) {
				names = append(names, fields[0])
			}
		}
	}
	operation := "notification-post"
	if all {
		operation = "notification-broadcast"
	}
	seen := make(map[string]bool)
	var failures []error
	for _, name := range names {
		if ctx.Err() != nil {
			return errors.Join(append(failures, ctx.Err())...)
		}
		name = strings.TrimSpace(name)
		if seen[name] {
			continue
		}
		seen[name] = true
		user, err := identity.LookupAccount(name)
		if err == nil {
			_, err = files.Run(ctx, user, files.Request{Operation: operation, Notice: &notification})
		}
		if err != nil {
			failures = append(failures, fmt.Errorf("%q: %w", name, err))
		}
	}
	return errors.Join(failures...)
}
