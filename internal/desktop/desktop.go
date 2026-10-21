package desktop

import (
	"bufio"
	"context"
	"crypto/rand"
	_ "embed"
	"errors"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	"tuxee/internal/identity"
)

//go:embed session.sh
var startup string

type process struct {
	address string
	cmd     *exec.Cmd
	done    chan struct{}
	mu      sync.Mutex
	exited  bool
}

func start(ctx context.Context, user identity.User, dir, password string) (*process, error) {
	for _, tool := range []string{"tuxee-Xvnc", "tuxee-vncpasswd", "matchbox-window-manager", "dbus-daemon"} {
		if _, err := exec.LookPath(tool); err != nil {
			return nil, fmt.Errorf("GUI runtime requires %s; use the Docker image or follow docs/guide.md", tool)
		}
	}
	// Let X own its display lock; a collision fails without touching another session.
	number, err := rand.Int(rand.Reader, big.NewInt(20000))
	if err != nil {
		return nil, err
	}
	display := ":" + strconv.Itoa(1000+int(number.Int64()))
	audio, _ := exec.LookPath("tuxee-pulseaudio")
	cmd := user.Command(context.Background(), "/bin/sh", "-c", startup, "tuxee-display", dir, audio)
	cmd.Dir = user.Home
	cmd.Env = append(cmd.Env, "DISPLAY="+display, "XAUTHORITY="+dir+"/Xauthority", "XDG_RUNTIME_DIR="+dir+"/xdg", "XDG_SESSION_TYPE=x11")
	cmd.Stdin = strings.NewReader(password + "\n")
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr.Setpgid = true
	output, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		output.Close()
		return nil, err
	}
	s := &process{address: "/tmp/.X11-unix/X" + strings.TrimPrefix(display, ":"), cmd: cmd, done: make(chan struct{})}
	go func() {
		// Keep the leader's PID allocated until group cleanup and reaping are serialized.
		var status unix.Siginfo
		for unix.Waitid(unix.P_PID, cmd.Process.Pid, &status, unix.WEXITED|unix.WNOWAIT, nil) == unix.EINTR {
		}
		s.mu.Lock()
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
		s.exited = true
		s.mu.Unlock()
		close(s.done)
	}()
	ready := make(chan bool, 1)
	go func() {
		line, err := bufio.NewReader(output).ReadString('\n')
		ready <- err == nil && line == "ready\n"
	}()
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	select {
	case ok := <-ready:
		if ok {
			return s, nil
		}
	case <-ctx.Done():
	case <-timer.C:
	}
	s.close()
	return nil, errors.New("GUI session failed to start; check the server log")
}

func (s *process) signal(signal syscall.Signal) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.exited {
		_ = syscall.Kill(-s.cmd.Process.Pid, signal)
	}
}

func (s *process) close() {
	s.signal(syscall.SIGTERM)
	select {
	case <-s.done:
	case <-time.After(time.Second):
		s.signal(syscall.SIGKILL)
		<-s.done
	}
}
