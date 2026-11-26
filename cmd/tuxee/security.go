package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"tuxee/internal/files"
	"tuxee/internal/identity"
	"tuxee/internal/security"
)

func runSecurity(args []string, output io.Writer) error {
	if len(args) == 0 || args[0] != "network" && args[0] != "unlock" {
		return errors.New("use security network [--allow IP/CIDR,... | --clear] [--trusted-proxies IP/CIDR,...] [--state DIR], or security unlock --user NAME [--name NAME] [--state DIR]")
	}
	operation := args[0]
	flags := flag.NewFlagSet("security "+operation, flag.ContinueOnError)
	name := flags.String("name", "", "select a named managed installation")
	state := flags.String("state", "", "select the instance state directory")
	userName := flags.String("user", "", "Linux account whose Tuxee 2FA will be cleared")
	clear := flags.Bool("clear", false, "remove network restrictions; applies without restarting")
	var allow, proxies *string
	flags.Func("allow", "comma-separated allowed IPv4/IPv6 addresses or CIDRs", func(value string) error { allow = &value; return nil })
	flags.Func("trusted-proxies", "comma-separated proxies trusted to append X-Forwarded-For", func(value string) error { proxies = &value; return nil })
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 || operation == "unlock" && (*userName == "" || *clear || allow != nil || proxies != nil) || operation == "network" && (*userName != "" || *clear && allow != nil) {
		return errors.New("invalid security arguments")
	}
	proc, record, err := selectRuntime(*name, *state)
	if err == nil {
		defer proc.Close()
		if err = checkRuntimeSignal(proc); err != nil {
			return fmt.Errorf("permission to administer Tuxee security: %w", err)
		}
		*state = record.State
	} else if !errors.Is(err, errRuntimeNotFound) || *name != "" {
		return err
	}
	if operation == "unlock" {
		user, err := identity.LookupAccount(*userName)
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err = files.Run(ctx, user, files.Request{Operation: "security-clear"}); err != nil {
			return fmt.Errorf("clear 2FA for %s: %w", user.Name, err)
		}
		fmt.Fprintf(output, "Cleared Tuxee 2FA for %s. The Linux password is unchanged.\n", user.Name)
		return nil
	}
	if *state == "" {
		*state = "/var/lib/tuxee"
	}
	if info, err := os.Stat(*state); err != nil {
		return err
	} else if !info.IsDir() {
		return errors.New("state must be an existing directory")
	}
	store := &security.NetworkStore{Directory: *state}
	value, err := store.Load()
	// Recovery must also work when the saved policy is malformed.
	if *clear {
		value = security.Network{AllowedNetworks: []string{}, TrustedProxies: []string{}}
		err = nil
	}
	if err != nil {
		return err
	}
	if allow != nil {
		value.AllowedNetworks = splitNetworks(*allow)
	}
	if proxies != nil {
		value.TrustedProxies = splitNetworks(*proxies)
	}
	if *clear || allow != nil || proxies != nil {
		if err = store.Save(value); err != nil {
			return err
		}
		fmt.Fprintln(output, "Saved. Network policy applies without restarting Tuxee.")
	}
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func splitNetworks(value string) []string {
	if strings.TrimSpace(value) == "" {
		return []string{}
	}
	values := strings.Split(value, ",")
	for index := range values {
		values[index] = strings.TrimSpace(values[index])
	}
	return values
}
