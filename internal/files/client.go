package files

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"tuxee/internal/identity"
)

type Process struct {
	Response Response
	Reader   io.Reader
	cmd      *exec.Cmd
	cancel   context.CancelFunc
	once     sync.Once
	err      error
	stderr   boundedOutput
}

func Start(ctx context.Context, user identity.User, request Request, body io.Reader) (*Process, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	header, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	header = append(header, '\n')
	ctx, cancel := context.WithCancel(ctx)
	cmd := user.Command(ctx, executable, "__files")
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = 3 * time.Second
	cmd.Stdin = bytes.NewReader(header)
	if body != nil {
		cmd.Stdin = io.MultiReader(cmd.Stdin, body)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	p := &Process{cmd: cmd, cancel: cancel}
	cmd.Stderr = &p.stderr
	if err = cmd.Start(); err != nil {
		cancel()
		return nil, err
	}
	reader := bufio.NewReader(stdout)
	line, err := reader.ReadBytes('\n')
	if err == nil {
		err = json.Unmarshal(line, &p.Response)
	}
	if err == nil && p.Response.Error != "" {
		err = errors.New(p.Response.Error)
	}
	if err != nil {
		p.Cancel()
		return nil, err
	}
	p.Reader = reader
	return p, nil
}
func (p *Process) Wait() error {
	p.once.Do(func() {
		p.err = p.cmd.Wait()
		if message := strings.TrimSpace(p.stderr.String()); p.err != nil && message != "" {
			p.err = fmt.Errorf("%s: %w", message, p.err)
		}
		p.cancel()
	})
	return p.err
}
func (p *Process) Cancel() { p.cancel(); _ = p.Wait() }
func Run(ctx context.Context, user identity.User, request Request) (Response, error) {
	p, err := Start(ctx, user, request, nil)
	if err != nil {
		return Response{}, err
	}
	defer p.Cancel()
	if err = p.Wait(); err != nil {
		return Response{}, err
	}
	return p.Response, nil
}
