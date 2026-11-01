package desktop

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"time"
	"tuxee/internal/files"
	"tuxee/internal/identity"
	"tuxee/internal/keeper"

	"golang.org/x/sys/unix"
)

type retainedDisplay struct {
	Version                        int
	Dir, Cookie, Address, Password string
	Env                            []string
}

func (d *Display) retain() error {
	data, err := json.Marshal(retainedDisplay{1, d.dir, d.cookie, d.Address, d.Password, d.Env})
	if err != nil {
		return err
	}
	for i, listener := range []*net.UnixListener{d.listener, d.abstract} {
		listener.SetUnlinkOnClose(false)
		f, err := listener.File()
		if err != nil {
			return err
		}
		err = d.keeper.Put(uint64(2+i), f)
		f.Close()
		if err != nil {
			return err
		}
	}
	return d.keeper.Save(1, data)
}

func (d *Display) acceptRetained(slot uint64) {
	for {
		client, err := d.keeper.Accept(d.ctx, slot)
		if err != nil {
			return
		}
		var peer *unix.Ucred
		raw, err := client.SyscallConn()
		if err == nil {
			err = raw.Control(func(fd uintptr) { peer, _ = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED) })
		}
		if err == nil && peer != nil && peer.Uid == d.user.UID {
			var upstream net.Conn
			upstream, err = d.connect()
			if err == nil {
				err = d.keeper.RelayAccepted(slot, client, upstream.(*net.UnixConn))
				upstream.Close()
			}
		} else {
			err = os.ErrPermission
		}
		client.Close()
		if d.ctx.Err() != nil {
			return
		}
		if err != nil {
			_ = d.keeper.Reject(slot)
		}
	}
}

func Restore(user identity.User, owner *keeper.Client) (*Display, error) {
	data, err := owner.Load(1, 16384)
	if err == unix.ENOENT {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var saved retainedDisplay
	if err = json.Unmarshal(data, &saved); err != nil {
		return nil, err
	}
	if saved.Version != 1 || !strings.HasPrefix(saved.Dir, "/tmp/tuxee-display-") || strings.Contains(saved.Dir[5:], "/") || len(saved.Cookie) != 32 || saved.Address != saved.Dir+"/vnc" {
		return nil, fmt.Errorf("invalid retained display")
	}
	d := &Display{Changes: make(chan struct{}, 1), user: user, dir: saved.Dir, cookie: saved.Cookie, Address: saved.Address, Password: saved.Password, Env: saved.Env, keeper: owner}
	d.ctx, d.cancel = context.WithCancel(context.Background())
	for i, target := range []**net.UnixListener{&d.listener, &d.abstract} {
		f, e := owner.Get(uint64(2 + i))
		if e != nil {
			d.Detach()
			return nil, e
		}
		listener, e := net.FileListener(f)
		f.Close()
		if e != nil {
			d.Detach()
			return nil, e
		}
		unixListener, ok := listener.(*net.UnixListener)
		if !ok {
			listener.Close()
			d.Detach()
			return nil, fmt.Errorf("invalid retained X listener")
		}
		unixListener.SetUnlinkOnClose(false)
		*target = unixListener
	}
	if _, exited, e := owner.Job(2); e == nil && !exited {
		// Observer failure must not turn recovery into termination of existing apps.
		_ = d.launch()
	}
	d.workers.Add(2)
	go d.accept(d.listener)
	go d.accept(d.abstract)
	return d, nil
}

func retainedProcess(job *keeper.Job, address string) *process {
	p := &process{address: address, job: job, done: make(chan struct{})}
	go func() { _ = job.Wait(); p.mu.Lock(); p.exited = true; p.mu.Unlock(); close(p.done) }()
	return p
}

func startRetained(ctx context.Context, user identity.User, cmd *exec.Cmd, owner *keeper.Client, display, password string) (*process, error) {
	cwd, err := keeper.OpenDirectory(user, cmd.Dir)
	if err != nil {
		return nil, err
	}
	defer cwd.Close()
	in, writer, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer in.Close()
	defer writer.Close()
	output, out, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer output.Close()
	defer out.Close()
	// The bounded password fits before spawn; no Go forwarding process must remain alive.
	if _, err = writer.WriteString(password + "\n"); err != nil {
		return nil, err
	}
	writer.Close()
	address := "/tmp/.X11-unix/X" + strings.TrimPrefix(display, ":")
	if err = owner.Save(4, []byte(address)); err != nil {
		return nil, err
	}
	job, err := owner.Spawn(2, cmd.Args, cmd.Env, cwd, in, out, os.Stderr, false)
	if err != nil {
		return nil, err
	}
	out.Close()
	p := retainedProcess(job, address)
	ready := make(chan bool, 1)
	go func() { line, e := bufio.NewReader(output).ReadString('\n'); ready <- e == nil && line == "ready\n" }()
	select {
	case ok := <-ready:
		if ok {
			return p, nil
		}
	case <-ctx.Done():
	case <-time.After(10 * time.Second):
	}
	p.close()
	return nil, fmt.Errorf("retained display failed to start")
}

// Detach closes Go observers without interrupting X clients or owned processes.
func (d *Display) Detach() {
	if d == nil {
		return
	}
	d.close.Do(func() {
		d.cancel()
		if d.listener != nil {
			d.listener.SetUnlinkOnClose(false)
			d.listener.Close()
		}
		if d.abstract != nil {
			d.abstract.SetUnlinkOnClose(false)
			d.abstract.Close()
		}
		d.runtime.Lock()
		d.mu.Lock()
		if d.idle != nil {
			d.idle.Stop()
			d.idle = nil
		}
		x := d.x
		d.x, d.windows, d.process = nil, nil, nil
		d.mu.Unlock()
		if x != nil {
			x.Close()
		}
		d.runtime.Unlock()
		d.workers.Wait()
	})
}

func (d *Display) remove(paths ...string) {
	for _, path := range paths {
		if d.keeper == nil {
			os.RemoveAll(path)
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, _ = files.Run(ctx, d.user, files.Request{Operation: "delete", Path: path})
		cancel()
	}
}

func (d *Display) dial(address string) (net.Conn, error) {
	c, err := (&net.Dialer{}).DialContext(d.ctx, "unix", address)
	if err != nil {
		return nil, err
	}
	raw, err := c.(*net.UnixConn).SyscallConn()
	var peer *unix.Ucred
	if err == nil {
		err = raw.Control(func(fd uintptr) { peer, _ = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED) })
	}
	if err != nil || peer == nil || peer.Uid != d.user.UID {
		c.Close()
		return nil, os.ErrPermission
	}
	return c, nil
}
