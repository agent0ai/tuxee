package audio

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
	"tuxee/internal/files"
	"tuxee/internal/identity"
	"tuxee/internal/keeper"

	"golang.org/x/sys/unix"
)

type retainedAudio struct {
	Version int
	Dir     string
	Env     []string
}

// Native references preserve the last-terminal rule even while Go is absent.
func (m *Manager) Bind(user identity.User, terminal *keeper.Client) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	a := m.users[user.UID]
	if a == nil || a.keeper == nil {
		return nil
	}
	read, write, err := os.Pipe()
	if err != nil {
		return err
	}
	defer read.Close()
	defer write.Close()
	if err = terminal.PutOwned(5, 1, write); err != nil {
		return err
	}
	if err = a.keeper.Track(read); err != nil {
		terminal.Put(5, nil)
	}
	return err
}

func preparePersistent(user identity.User, instance string) (*runtime, error) {
	cleanupOrphans(instance)
	owner, err := keeper.Connect(user, "audio", instance)
	if err != nil {
		owner, err = keeper.Start(user, "audio", instance)
		if err != nil {
			return nil, err
		}
		a, err := prepareOwned(user, owner, instance)
		if err != nil {
			owner.Stop()
			owner.Close()
		}
		return a, err
	}
	a, err := restore(user, owner)
	if err != nil {
		owner.Close()
	}
	return a, err
}

func (a *runtime) trackController() error {
	read, write, err := os.Pipe()
	if err != nil {
		return err
	}
	defer read.Close()
	if err = a.keeper.Track(read); err != nil {
		write.Close()
		return err
	}
	a.controller = write
	return nil
}

func (a *runtime) retain() error {
	if err := a.trackController(); err != nil {
		return err
	}
	a.listener.SetUnlinkOnClose(false)
	f, err := a.listener.File()
	if err != nil {
		return err
	}
	defer f.Close()
	if err = a.keeper.Put(2, f); err != nil {
		return err
	}
	data, err := json.Marshal(retainedAudio{1, a.dir, a.env})
	if err != nil {
		return err
	}
	return a.keeper.Save(1, data)
}

func (a *runtime) acceptRetained() {
	for {
		client, err := a.keeper.Accept(a.ctx, 2)
		if err != nil {
			return
		}
		if sameUser(client, a.user.UID) {
			var upstream net.Conn
			upstream, err = a.connect()
			if err == nil {
				err = a.keeper.RelayAccepted(2, client, upstream.(*net.UnixConn))
				upstream.Close()
			}
		} else {
			err = os.ErrPermission
		}
		client.Close()
		if a.ctx.Err() != nil {
			return
		}
		if err != nil {
			_ = a.keeper.Reject(2)
		}
	}
}

func restore(user identity.User, owner *keeper.Client) (*runtime, error) {
	data, err := owner.Load(1, 16384)
	if err != nil {
		return nil, err
	}
	var saved retainedAudio
	if err = json.Unmarshal(data, &saved); err != nil {
		return nil, err
	}
	if saved.Version != 1 || !strings.HasPrefix(saved.Dir, "/tmp/tuxee-audio-") || strings.Contains(saved.Dir[5:], "/") {
		return nil, fmt.Errorf("invalid retained audio")
	}
	f, err := owner.Get(2)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	listener, err := net.FileListener(f)
	if err != nil {
		return nil, err
	}
	unixListener, ok := listener.(*net.UnixListener)
	if !ok {
		listener.Close()
		return nil, fmt.Errorf("invalid retained audio listener")
	}
	unixListener.SetUnlinkOnClose(false)
	a := &runtime{user: user, dir: saved.Dir, env: saved.Env, keeper: owner, listener: unixListener, listeners: map[chan []byte]struct{}{}}
	a.ctx, a.cancel = context.WithCancel(context.Background())
	// This directory was created by Tuxee and remains root-owned, unlike user metadata.
	info, err := os.Lstat(a.dir)
	if err != nil || !info.IsDir() || info.Sys().(*syscall.Stat_t).Uid != uint32(os.Geteuid()) {
		a.cancel()
		listener.Close()
		return nil, os.ErrPermission
	}
	a.files, err = os.OpenRoot(a.dir)
	if err != nil {
		a.cancel()
		listener.Close()
		return nil, err
	}
	info, err = a.files.Stat("pulse")
	if err != nil || !info.IsDir() || info.Sys().(*syscall.Stat_t).Uid != user.UID {
		a.files.Close()
		a.cancel()
		listener.Close()
		return nil, os.ErrPermission
	}
	if err = a.trackController(); err != nil {
		a.files.Close()
		a.cancel()
		listener.Close()
		return nil, err
	}
	if job, exited, e := owner.Job(1); e == nil && !exited {
		a.watchJob(job)
	}
	a.workers.Add(1)
	go a.accept()
	return a, nil
}

func (a *runtime) watchJob(job *keeper.Job) {
	a.job = job
	a.exited = make(chan struct{})
	exited := a.exited
	go func() { _ = job.Wait(); close(exited) }()
}

func (a *runtime) startRetainedLocked() error {
	if a.job != nil {
		select {
		case <-a.exited:
			a.stopCaptureLocked()
			a.job = nil
		default:
			return a.captureLocked()
		}
	}
	a.files.Remove("pulse/native")
	tool, err := exec.LookPath("tuxee-pulseaudio")
	if err != nil {
		return err
	}
	cmd := a.user.Command(context.Background(), tool, "--daemonize=no", "--exit-idle-time=-1", "--use-pid-file=no", "--disable-shm", "--high-priority=no", "--realtime=no", "--resample-method=ffmpeg", "-n", "-F", a.dir+"/default.pa")
	cmd.Env = append(cmd.Env, "PULSE_RUNTIME_PATH="+a.dir+"/pulse", "PULSE_STATE_PATH="+a.dir+"/pulse")
	cwd, err := keeper.OpenDirectory(a.user, cmd.Dir)
	if err != nil {
		return err
	}
	defer cwd.Close()
	null, err := os.OpenFile("/dev/null", os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer null.Close()
	job, err := a.keeper.Spawn(1, cmd.Args, cmd.Env, cwd, null, null, os.Stderr, false)
	if err != nil {
		return err
	}
	a.watchJob(job)
	for i := 0; i < 250; i++ {
		if info, e := a.files.Stat("pulse/native"); e == nil && info.Mode()&os.ModeSocket != 0 {
			return a.captureLocked()
		}
		select {
		case <-a.exited:
			a.job = nil
			return fmt.Errorf("retained audio exited during startup")
		case <-a.ctx.Done():
			return a.ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
	job.Signal(unix.SIGKILL)
	<-a.exited
	a.job = nil
	return fmt.Errorf("retained audio startup timed out")
}

func (a *runtime) remove() {
	// The parent is server-owned; only its user-owned contents need delegated access.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, path := range []string{a.dir + "/pulse", a.dir + "/native", a.dir + "/cookie", a.dir + "/default.pa"} {
		_, _ = files.Run(ctx, a.user, files.Request{Operation: "delete", Path: path})
	}
	os.RemoveAll(a.dir)
}

func (m *Manager) Detach() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return
	}
	m.closed = true
	for _, a := range m.users {
		if a.keeper == nil {
			a.close()
			continue
		}
		a.closeOnce.Do(func() {
			a.cancel()
			a.listener.SetUnlinkOnClose(false)
			a.listener.Close()
			a.mu.Lock()
			a.stopCaptureLocked()
			for listener := range a.listeners {
				close(listener)
				delete(a.listeners, listener)
			}
			a.mu.Unlock()
			a.workers.Wait()
			a.files.Close()
			a.keeper.Close()
			if a.controller != nil {
				a.controller.Close()
			}
		})
	}
}
