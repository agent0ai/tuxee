package audio

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"sync"
	"time"

	"golang.org/x/sys/unix"
	"tuxee/internal/identity"
)

const Frames = 960
const PacketBytes = 8 + Frames*4

type Manager struct {
	mu     sync.Mutex
	users  map[uint32]*runtime
	closed bool
}

type runtime struct {
	user      identity.User
	dir       string
	files     *os.Root
	env       []string
	listener  *net.UnixListener
	ctx       context.Context
	cancel    context.CancelFunc
	workers   sync.WaitGroup
	closeOnce sync.Once
	browsers  int // guarded by Manager.mu
	mu        sync.Mutex
	terminals int
	process   *exec.Cmd
	exited    chan struct{}
	capture   *capture
	listeners map[chan []byte]struct{}
}

type capture struct {
	cancel context.CancelFunc
	ready  chan struct{}
	exited chan struct{}
}

func Available() bool {
	_, a := exec.LookPath("tuxee-pulseaudio")
	_, b := exec.LookPath("tuxee-pacat")
	return a == nil && b == nil
}

func (m *Manager) acquire(user identity.User, browser bool) (*runtime, func(), error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, nil, errors.New("audio is stopping")
	}
	if !Available() {
		return nil, nil, errors.New("audio runtime is unavailable")
	}
	if m.users == nil {
		m.users = make(map[uint32]*runtime)
	}
	a := m.users[user.UID]
	if a == nil {
		var err error
		a, err = prepare(user)
		if err != nil {
			return nil, nil, err
		}
		m.users[user.UID] = a
	}
	if browser {
		if a.browsers >= 8 {
			return nil, nil, errors.New("too many audio listeners")
		}
		a.browsers++
	} else {
		a.mu.Lock()
		a.terminals++
		a.mu.Unlock()
	}
	var once sync.Once
	return a, func() {
		once.Do(func() {
			m.mu.Lock()
			defer m.mu.Unlock()
			if browser {
				a.browsers--
			}
			a.mu.Lock()
			if !browser {
				a.terminals--
			}
			idle := a.terminals == 0
			if idle {
				a.stopLocked()
			}
			a.mu.Unlock()
			if idle && a.browsers == 0 {
				a.close()
				delete(m.users, user.UID)
			}
		})
	}, nil
}

func (m *Manager) Environment(user identity.User) ([]string, func(), error) {
	if !Available() {
		return nil, func() {}, nil
	}
	a, release, err := m.acquire(user, false)
	if err != nil {
		return nil, nil, err
	}
	return a.env, release, nil
}

func (m *Manager) Subscribe(user identity.User) (<-chan []byte, func(), error) {
	a, release, err := m.acquire(user, true)
	if err != nil {
		return nil, nil, err
	}
	packets := make(chan []byte, 10)
	a.mu.Lock()
	err = a.ctx.Err()
	if err == nil {
		a.listeners[packets] = struct{}{}
		err = a.captureLocked()
	}
	if err != nil {
		delete(a.listeners, packets)
	}
	a.mu.Unlock()
	if err != nil {
		release()
		return nil, nil, err
	}
	var once sync.Once
	return packets, func() {
		once.Do(func() {
			a.mu.Lock()
			delete(a.listeners, packets)
			if len(a.listeners) == 0 {
				a.stopCaptureLocked()
			}
			a.mu.Unlock()
			release()
		})
	}, nil
}

func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	for _, a := range m.users {
		a.close()
	}
}

func prepare(user identity.User) (*runtime, error) {
	dir, err := os.MkdirTemp("", "tuxee-audio-")
	if err != nil {
		return nil, err
	}
	a := &runtime{user: user, dir: dir, listeners: make(map[chan []byte]struct{})}
	a.ctx, a.cancel = context.WithCancel(context.Background())
	ok := false
	defer func() {
		if !ok {
			a.close()
		}
	}()
	a.files, err = os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	if err = os.Mkdir(dir+"/pulse", 0700); err != nil {
		return nil, err
	}
	if err = os.Chown(dir+"/pulse", int(user.UID), int(user.GID)); err != nil {
		return nil, err
	}
	cookie := make([]byte, 256)
	if _, err = rand.Read(cookie); err != nil {
		return nil, err
	}
	if err = os.WriteFile(dir+"/cookie", cookie, 0600); err != nil {
		return nil, err
	}
	if err = os.Chown(dir+"/cookie", int(user.UID), int(user.GID)); err != nil {
		return nil, err
	}
	// A monitor cannot retract delivered samples when a new playback client rewinds the sink.
	config := fmt.Sprintf("load-module module-null-sink sink_name=tuxee format=s16le channels=2 rate=48000 norewinds=true\nset-default-sink tuxee\nset-default-source tuxee.monitor\nload-module module-native-protocol-unix socket=%s/pulse/native auth-cookie=%s/cookie\n", dir, dir)
	if err = os.WriteFile(dir+"/default.pa", []byte(config), 0600); err != nil {
		return nil, err
	}
	if err = os.Chown(dir+"/default.pa", int(user.UID), int(user.GID)); err != nil {
		return nil, err
	}
	a.listener, err = net.ListenUnix("unix", &net.UnixAddr{Name: dir + "/native", Net: "unix"})
	if err != nil {
		return nil, err
	}
	if err = os.Chmod(dir+"/native", 0600); err != nil {
		return nil, err
	}
	if err = os.Chown(dir+"/native", int(user.UID), int(user.GID)); err != nil {
		return nil, err
	}
	// Keep the parent server-owned so applications cannot replace public paths.
	if err = os.Chmod(dir, 0711); err != nil {
		return nil, err
	}
	a.env = []string{"PULSE_SERVER=unix:" + dir + "/native", "PULSE_COOKIE=" + dir + "/cookie"}
	a.workers.Add(1)
	go a.accept()
	ok = true
	return a, nil
}

func (a *runtime) accept() {
	defer a.workers.Done()
	for {
		client, err := a.listener.AcceptUnix()
		if err != nil {
			return
		}
		if !sameUser(client, a.user.UID) {
			client.Close()
			continue
		}
		a.workers.Add(1)
		go func() {
			defer a.workers.Done()
			defer client.Close()
			stop := context.AfterFunc(a.ctx, func() { client.Close() })
			defer stop()
			upstream, err := a.connect()
			if err != nil {
				return
			}
			defer upstream.Close()
			stopUpstream := context.AfterFunc(a.ctx, func() { upstream.Close() })
			defer stopUpstream()
			done := make(chan struct{})
			go func() { io.Copy(upstream, client); upstream.Close(); close(done) }()
			io.Copy(client, upstream)
			client.Close()
			<-done
		}()
	}
}

func (a *runtime) connect() (net.Conn, error) {
	a.mu.Lock()
	err := a.startLocked()
	c := a.capture
	a.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if c != nil {
		// Capture silence first so a short initial sound cannot outrun the recorder.
		select {
		case <-c.ready:
		case <-a.ctx.Done():
			return nil, a.ctx.Err()
		case <-time.After(5 * time.Second):
			return nil, errors.New("audio capture did not become ready")
		}
	}
	upstream, err := (&net.Dialer{}).DialContext(a.ctx, "unix", a.dir+"/pulse/native")
	if err != nil {
		return nil, err
	}
	if !sameUser(upstream.(*net.UnixConn), a.user.UID) {
		upstream.Close()
		return nil, errors.New("audio socket belongs to another user")
	}
	return upstream, nil
}

func sameUser(conn *net.UnixConn, uid uint32) bool {
	var peer *unix.Ucred
	raw, err := conn.SyscallConn()
	if err == nil {
		err = raw.Control(func(fd uintptr) { peer, _ = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED) })
	}
	return err == nil && peer != nil && peer.Uid == uid
}

func (a *runtime) startLocked() error {
	if err := a.ctx.Err(); err != nil {
		return err
	}
	if a.terminals == 0 {
		return errors.New("no running terminals")
	}
	if a.process != nil {
		select {
		case <-a.exited:
			a.stopCaptureLocked()
			a.process = nil
		default:
			return a.captureLocked()
		}
	}
	a.files.Remove("pulse/native")
	tool, err := exec.LookPath("tuxee-pulseaudio")
	if err != nil {
		return err
	}
	cmd := a.user.Command(a.ctx, tool, "--daemonize=no", "--exit-idle-time=-1", "--use-pid-file=no", "--disable-shm", "--high-priority=no", "--realtime=no", "--resample-method=ffmpeg", "-n", "-F", a.dir+"/default.pa")
	cmd.Env = append(cmd.Env, "PULSE_RUNTIME_PATH="+a.dir+"/pulse", "PULSE_STATE_PATH="+a.dir+"/pulse")
	cmd.Stderr = os.Stderr
	if err = cmd.Start(); err != nil {
		return err
	}
	a.process, a.exited = cmd, make(chan struct{})
	exited := a.exited
	go func() { cmd.Wait(); close(exited) }()
	for i := 0; i < 250; i++ {
		if info, err := a.files.Stat("pulse/native"); err == nil && info.Mode()&os.ModeSocket != 0 {
			return a.captureLocked()
		}
		select {
		case <-exited:
			a.process = nil
			return errors.New("audio server stopped during startup")
		case <-a.ctx.Done():
			return a.ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
	cmd.Process.Kill()
	<-exited
	a.process = nil
	return errors.New("audio server startup timed out")
}

func (a *runtime) captureLocked() error {
	if a.process == nil || a.capture != nil || len(a.listeners) == 0 {
		return nil
	}
	ctx, cancel := context.WithCancel(a.ctx)
	tool, err := exec.LookPath("tuxee-pacat")
	if err != nil {
		cancel()
		return err
	}
	cmd := a.user.Command(ctx, tool, "--record", "--raw", "--format=s16le", "--rate=48000", "--channels=2", "--latency-msec=20", "--process-time-msec=10", "--device=tuxee.monitor")
	cmd.Env = append(cmd.Env, "PULSE_SERVER=unix:"+a.dir+"/pulse/native", "PULSE_COOKIE="+a.dir+"/cookie")
	cmd.Stderr = os.Stderr
	output, err := cmd.StdoutPipe()
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		cancel()
		if output != nil {
			output.Close()
		}
		return err
	}
	c := &capture{cancel: cancel, ready: make(chan struct{}), exited: make(chan struct{})}
	a.capture = c
	go func() { cmd.Wait(); close(c.exited) }()
	a.workers.Add(1)
	go func() {
		defer a.workers.Done()
		defer func() { cancel(); <-c.exited }()
		defer output.Close()
		ready := false
		defer func() {
			if !ready {
				close(c.ready)
			}
		}()
		packet := make([]byte, PacketBytes)
		for position := uint64(0); ; position += Frames {
			_, err := io.ReadFull(output, packet[8:])
			if !ready && err == nil {
				close(c.ready)
				ready = true
			}
			a.mu.Lock()
			if a.capture != c {
				a.mu.Unlock()
				return
			}
			if err != nil {
				a.capture = nil
				for listener := range a.listeners {
					close(listener)
					delete(a.listeners, listener)
				}
				a.mu.Unlock()
				return
			}
			if !silent(packet[8:]) {
				binary.LittleEndian.PutUint64(packet, position)
				data := bytes.Clone(packet)
				for listener := range a.listeners {
					select {
					case listener <- data:
					default:
						close(listener)
						delete(a.listeners, listener)
					}
				}
			}
			a.mu.Unlock()
		}
	}()
	return nil
}

func silent(pcm []byte) bool {
	for _, value := range pcm {
		if value != 0 {
			return false
		}
	}
	return true
}

func (a *runtime) stopCaptureLocked() {
	if c := a.capture; c != nil {
		a.capture = nil
		c.cancel()
		<-c.exited
	}
}

func (a *runtime) stopLocked() {
	a.stopCaptureLocked()
	if a.process != nil {
		a.process.Process.Kill()
		<-a.exited
		a.process = nil
	}
	if a.files != nil {
		a.files.Remove("pulse/native")
	}
}

func (a *runtime) close() {
	a.closeOnce.Do(func() {
		a.cancel()
		if a.listener != nil {
			a.listener.Close()
		}
		a.mu.Lock()
		a.stopLocked()
		a.mu.Unlock()
		a.workers.Wait()
		a.mu.Lock()
		for listener := range a.listeners {
			close(listener)
			delete(a.listeners, listener)
		}
		a.mu.Unlock()
		if a.files != nil {
			a.files.Close()
		}
		os.RemoveAll(a.dir)
	})
}
