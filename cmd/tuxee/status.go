package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"text/tabwriter"
	"time"

	"tuxee/internal/server"
	"tuxee/internal/service"
)

const statusTimeout = 4 * time.Second

type runtimeListener struct {
	Address string `json:"address"`
	HTTPS   bool   `json:"https"`
}

type runtimeStatus struct {
	Version   string            `json:"version"`
	StartedAt time.Time         `json:"startedAt"`
	Listeners []runtimeListener `json:"listeners"`
}

type runtimeActivity struct {
	Users     int `json:"users"`
	Terminals int `json:"terminals"`
}

func statusSocket(directory string, pid int) string {
	return filepath.Join(directory, strconv.Itoa(pid)+".sock")
}

// The server's private umask and root-owned directory protect the socket from creation onward.
func serveStatus(directory string, app *server.Server) (func(), error) {
	if err := checkRuntimeDirectory(directory); err != nil {
		return nil, err
	}
	path := statusSocket(directory, os.Getpid())
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("not a status socket: %s", path)
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0600); err != nil {
		listener.Close()
		return nil, err
	}
	local := &http.Server{
		ReadHeaderTimeout: statusTimeout, WriteTimeout: statusTimeout, IdleTimeout: statusTimeout,
		MaxHeaderBytes: 4096,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet || r.URL.Path != "/" {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			_ = json.NewEncoder(w).Encode(runtimeActivity{app.SignedInUsers(), app.Terminals.RunningCount()})
		}),
	}
	go func() {
		if err := local.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
			fmt.Fprintln(os.Stderr, "Tuxee status:", err)
		}
	}()
	return func() {
		_ = local.Close()
		_ = listener.Close()
	}, nil
}

func readActivity(directory string, pid int) (runtimeActivity, error) {
	var activity runtimeActivity
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return new(net.Dialer).DialContext(ctx, "unix", statusSocket(directory, pid))
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: statusTimeout}
	response, err := client.Get("http://unix/")
	if err != nil {
		return activity, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return activity, fmt.Errorf("HTTP %d", response.StatusCode)
	}
	err = json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&activity)
	return activity, err
}

func checkListeners(listeners []runtimeListener, timeout time.Duration) []string {
	results := make([]string, len(listeners))
	var pending sync.WaitGroup
	for i, listener := range listeners {
		pending.Go(func() {
			results[i] = "OK"
			if err := probeHealth(listenerConfig{listener.Address, listener.HTTPS}, timeout); err != nil {
				var networkError net.Error
				var request *url.Error
				switch {
				case errors.As(err, &networkError) && networkError.Timeout():
					results[i] = "Timeout"
				case errors.Is(err, syscall.ECONNREFUSED):
					results[i] = "Connection refused"
				case errors.As(err, &request):
					results[i] = request.Err.Error()
				default:
					results[i] = err.Error()
				}
			}
		})
	}
	pending.Wait()
	return results
}

func statusUptime(elapsed time.Duration) string {
	seconds := max(0, int64(elapsed/time.Second))
	switch {
	case seconds >= 86400:
		return fmt.Sprintf("%dd %dh", seconds/86400, seconds%86400/3600)
	case seconds >= 3600:
		return fmt.Sprintf("%dh %dm", seconds/3600, seconds%3600/60)
	case seconds >= 60:
		return fmt.Sprintf("%dm %ds", seconds/60, seconds%60)
	default:
		return fmt.Sprintf("%ds", seconds)
	}
}

func runStatus(args []string, output io.Writer) error {
	f := flag.NewFlagSet("status", flag.ContinueOnError)
	name := f.String("name", "", "show this named managed installation's runtime")
	state := f.String("state", "", "select an instance by its state directory")
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("unexpected status arguments")
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
	return showStatus(output, runtimeDirectory, executable, *state)
}

func showStatus(output io.Writer, directory, executable, state string) error {
	proc, record, err := findRuntime(directory, executable, state)
	if err != nil && !errors.Is(err, errRuntimeNotFound) {
		return err
	}
	if proc != nil {
		defer proc.Close()
	}
	w := tabwriter.NewWriter(output, 0, 0, 3, ' ', 0)
	fmt.Fprintln(w, "Tuxee status")
	if record == nil {
		fmt.Fprintln(w, "  Status\tNot running\n  Health\t—")
		if err := w.Flush(); err != nil {
			return err
		}
		return reportedError{errRuntimeNotFound}
	}
	fmt.Fprintln(w, "  Status\tRunning")
	if record.Status == nil || len(record.Status.Listeners) == 0 {
		fmt.Fprintf(w, "  Health\tUnknown\n  PID\t%d\n\nRestart Tuxee to enable runtime details.\n", record.PID)
		if err := w.Flush(); err != nil {
			return err
		}
		return reportedError{errors.New("runtime details unavailable")}
	}
	var activity runtimeActivity
	var activityErr error
	activityDone := make(chan struct{})
	go func() {
		defer close(activityDone)
		activity, activityErr = readActivity(directory, record.PID)
	}()
	status := record.Status
	results := checkListeners(status.Listeners, statusTimeout)
	passed := 0
	for _, result := range results {
		if result == "OK" {
			passed++
		}
	}
	health := "Healthy"
	if passed == 0 {
		health = "Unresponsive"
	} else if passed != len(results) {
		health = "Degraded"
	}
	fmt.Fprintf(w, "  Health\t%s\n  Version\t%s\n  PID\t%d\n  Uptime\t%s\n", health, status.Version, record.PID, statusUptime(time.Since(status.StartedAt)))
	for _, https := range []bool{false, true} {
		protocol, value := "HTTP", "Disabled"
		if https {
			protocol = "HTTPS"
		}
		for i, listener := range status.Listeners {
			if listener.HTTPS == https {
				value = listener.Address + "  " + results[i]
			}
		}
		fmt.Fprintf(w, "  %s\t%s\n", protocol, value)
	}
	<-activityDone
	if activityErr == nil {
		label := "users"
		if activity.Users == 1 {
			label = "user"
		}
		fmt.Fprintf(w, "  Sessions\t%d signed-in %s\n  Terminals\t%d running\n", activity.Users, label, activity.Terminals)
	} else {
		reason := "Unavailable"
		if errors.Is(activityErr, os.ErrPermission) {
			reason += " (requires root)"
		}
		fmt.Fprintf(w, "  Sessions\t%s\n  Terminals\t%s\n", reason, reason)
	}
	if err := w.Flush(); err != nil {
		return err
	}
	if health != "Healthy" {
		return reportedError{errors.New(health)}
	}
	return nil
}
