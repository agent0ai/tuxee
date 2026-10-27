package files

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
	"tuxee/internal/i18n"

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
	header, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	header = append(header, '\n')
	ctx, cancel := context.WithCancel(ctx)
	cmd := user.Command(ctx, identity.Self, "__files")
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
		err = i18n.From(p.Response.Text, p.Response.Error)
	}
	if err != nil {
		p.Cancel()
		if errors.Is(err, io.EOF) && p.err != nil {
			return nil, p.err
		}
		return nil, err
	}
	p.Reader = reader
	return p, nil
}
func (p *Process) Wait() error {
	p.once.Do(func() {
		p.err = p.cmd.Wait()
		if message := strings.TrimSpace(p.stderr.String()); p.err != nil && message != "" {
			var text i18n.Message
			if json.Unmarshal([]byte(message), &text) == nil && text.Key != "" {
				p.err = i18n.Wrap(text.Key, p.err, text.Vars)
			} else {
				p.err = i18n.Wrap("backend.files.workerFailed", p.err, i18n.Vars{"message": message, "detail": i18n.Describe(p.err)})
			}
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
