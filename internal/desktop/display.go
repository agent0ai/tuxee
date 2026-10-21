package desktop

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/jezek/xgb"
	"golang.org/x/sys/unix"
	"tuxee/internal/identity"
)

type State struct {
	Ready   bool     `json:"ready"`
	Audio   bool     `json:"audio,omitempty"`
	Error   string   `json:"error,omitempty"`
	Windows []Window `json:"windows"`
}

// Display owns a terminal's stable X endpoint; preparing one starts no processes.
type Display struct {
	Changes              chan struct{}
	Env                  []string
	Address, Password    string
	user                 identity.User
	dir, backend, cookie string
	listener             *net.UnixListener
	abstract             *net.UnixListener
	ctx                  context.Context
	cancel               context.CancelFunc
	runtime              sync.Mutex
	close                sync.Once
	workers              sync.WaitGroup
	mu                   sync.Mutex
	state                State
	process              *process
	x                    *xgb.Conn
	windows              *windowManager
	idle                 *time.Timer
}

func Prepare(user identity.User) (*Display, error) {
	// Native installations without the optional runtime keep ordinary terminals.
	if _, err := exec.LookPath("tuxee-Xvnc"); err != nil {
		return nil, nil
	}
	dir, err := os.MkdirTemp("", "tuxee-display-")
	if err != nil {
		return nil, err
	}
	d := &Display{Changes: make(chan struct{}, 1), user: user, dir: dir}
	d.ctx, d.cancel = context.WithCancel(context.Background())
	ok := false
	defer func() {
		if !ok {
			d.Close()
		}
	}()
	if err = os.Chown(dir, int(user.UID), int(user.GID)); err != nil {
		return nil, err
	}
	if err = os.Mkdir(dir+"/xdg", 0700); err != nil {
		return nil, err
	}
	if err = os.Chown(dir+"/xdg", int(user.UID), int(user.GID)); err != nil {
		return nil, err
	}
	// Reserve both Linux transports so Xlib cannot pick another server's abstract socket.
	if err = os.Mkdir("/tmp/.X11-unix", os.ModeSticky|0777); err == nil {
		err = os.Chmod("/tmp/.X11-unix", os.ModeSticky|0777)
	} else if os.IsExist(err) {
		err = nil
	}
	if err != nil {
		return nil, err
	}
	var secret [26]byte
	if _, err = rand.Read(secret[:]); err != nil {
		return nil, err
	}
	d.cookie = hex.EncodeToString(secret[:16])
	d.Password = base64.RawStdEncoding.EncodeToString(secret[16:22])
	d.Address = dir + "/vnc"
	var number string
	for i := 0; i < 100; i++ {
		number = fmt.Sprint(30000 + (int(binary.BigEndian.Uint32(secret[22:]))+i)%20000)
		d.listener, err = net.ListenUnix("unix", &net.UnixAddr{Name: "/tmp/.X11-unix/X" + number, Net: "unix"})
		if err == nil {
			d.abstract, err = net.ListenUnix("unix", &net.UnixAddr{Name: "\x00/tmp/.X11-unix/X" + number, Net: "unix"})
			if err == nil {
				break
			}
			d.listener.Close()
			d.listener = nil
		}
	}
	if err != nil {
		return nil, err
	}
	if err = os.Chmod(d.listener.Addr().String(), 0600); err != nil {
		return nil, err
	}
	if err = os.Chown(d.listener.Addr().String(), int(user.UID), int(user.GID)); err != nil {
		return nil, err
	}
	// FamilyWild accepts the same private cookie at the public and backing displays.
	auth := []byte{255, 255}
	for _, field := range [][]byte{nil, nil, []byte("MIT-MAGIC-COOKIE-1"), secret[:16]} {
		auth = binary.BigEndian.AppendUint16(auth, uint16(len(field)))
		auth = append(auth, field...)
	}
	if err = os.WriteFile(dir+"/Xauthority", auth, 0600); err != nil {
		return nil, err
	}
	if err = os.Chown(dir+"/Xauthority", int(user.UID), int(user.GID)); err != nil {
		return nil, err
	}
	d.Env = []string{"DISPLAY=:" + number, "XAUTHORITY=" + dir + "/Xauthority", "XDG_RUNTIME_DIR=" + dir + "/xdg", "XDG_SESSION_TYPE=x11", "DBUS_SESSION_BUS_ADDRESS=unix:path=" + dir + "/bus"}
	if _, err := exec.LookPath("tuxee-pulseaudio"); err == nil {
		d.Env = append(d.Env, "PULSE_SERVER=unix:"+dir+"/pulse/native", "PULSE_COOKIE="+dir+"/pulse/cookie")
	}
	d.workers.Add(2)
	go d.accept(d.listener)
	go d.accept(d.abstract)
	ok = true
	return d, nil
}

func (d *Display) State() *State {
	if d == nil {
		return nil
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	value := d.state
	return &value
}

func (d *Display) changed() {
	select {
	case d.Changes <- struct{}{}:
	default:
	}
}

func (d *Display) accept(listener *net.UnixListener) {
	defer d.workers.Done()
	for {
		client, err := listener.AcceptUnix()
		if err != nil {
			return
		}
		// Check credentials as well as file permissions before allocating an X server.
		var peer *unix.Ucred
		raw, err := client.SyscallConn()
		if err == nil {
			err = raw.Control(func(fd uintptr) { peer, _ = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED) })
		}
		if err != nil || peer == nil || peer.Uid != d.user.UID {
			client.Close()
			continue
		}
		d.workers.Add(1)
		go func() {
			defer d.workers.Done()
			defer client.Close()
			stop := context.AfterFunc(d.ctx, func() { client.Close() })
			defer stop()
			upstream, err := d.connect()
			if err != nil {
				return
			}
			defer upstream.Close()
			stopUpstream := context.AfterFunc(d.ctx, func() { upstream.Close() })
			defer stopUpstream()
			done := make(chan struct{})
			go func() { io.Copy(upstream, client); upstream.Close(); close(done) }()
			io.Copy(client, upstream)
			client.Close()
			<-done
		}()
	}
}

func (d *Display) connect() (net.Conn, error) {
	d.runtime.Lock()
	defer d.runtime.Unlock()
	if err := d.ctx.Err(); err != nil {
		return nil, err
	}
	if d.process == nil {
		if err := d.launch(); err != nil {
			return nil, err
		}
	}
	d.mu.Lock()
	if len(d.state.Windows) == 0 {
		// Give a newly connecting application time to create its first window.
		d.releaseAfterLocked(30 * time.Second)
	}
	d.mu.Unlock()
	return (&net.Dialer{}).DialContext(d.ctx, "unix", d.backend)
}

// The runtime lock serializes startup, connections and teardown; state stays readable.
func (d *Display) launch() error {
	p, err := start(d.ctx, d.user, d.dir, d.Password)
	var x *xgb.Conn
	var windows *windowManager
	if err == nil {
		var connection net.Conn
		connection, err = (&net.Dialer{}).DialContext(d.ctx, "unix", p.address)
		if err == nil {
			connection.SetDeadline(time.Now().Add(10 * time.Second))
			x, err = xgb.NewConnNetWithCookieHex(connection, d.cookie)
			connection.SetDeadline(time.Time{})
			if err != nil {
				connection.Close()
			}
		}
		if err == nil {
			windows, err = newWindowManager(x, d)
		}
	}
	d.mu.Lock()
	d.process, d.x, d.windows = p, x, windows
	if err != nil {
		d.mu.Unlock()
		d.stop(err.Error(), nil)
		return err
	}
	d.backend = p.address
	_, audioErr := os.Stat(d.dir + "/pulse/native")
	d.state = State{Ready: true, Audio: audioErr == nil}
	d.mu.Unlock()
	d.changed()
	d.workers.Add(1)
	go func() {
		defer d.workers.Done()
		windows.watch()
		d.runtime.Lock()
		defer d.runtime.Unlock()
		if d.windows == windows {
			d.stop("Display ended", nil)
		}
	}()
	return nil
}

// Called with mu held. A replacement timer invalidates an already-firing callback.
func (d *Display) releaseAfterLocked(delay time.Duration) {
	if d.idle != nil {
		d.idle.Stop()
	}
	var timer *time.Timer
	timer = time.AfterFunc(delay, func() {
		d.runtime.Lock()
		defer d.runtime.Unlock()
		d.mu.Lock()
		expected := timer
		d.mu.Unlock()
		d.stop("", expected)
	})
	d.idle = timer
}

// Called with runtime held; preserve the terminal's public endpoint and X cookie.
func (d *Display) stop(message string, idle *time.Timer) {
	d.mu.Lock()
	if idle != nil && (d.idle != idle || len(d.state.Windows) != 0) {
		d.mu.Unlock()
		return
	}
	if d.idle != nil {
		d.idle.Stop()
		d.idle = nil
	}
	x, p := d.x, d.process
	d.x, d.process, d.windows, d.backend = nil, nil, nil, ""
	d.state = State{Error: message}
	d.mu.Unlock()
	d.changed()
	if x != nil {
		x.Close()
	}
	if p != nil {
		p.close()
	}
	for _, name := range []string{"ready", "vnc", "bus", "passwd"} {
		os.Remove(d.dir + "/" + name)
	}
	os.RemoveAll(d.dir + "/pulse")
}

func (d *Display) Activate(id uint32) error {
	windows, err := d.window(id)
	if err != nil {
		return err
	}
	return windows.activate(id)
}

func (d *Display) CloseWindow(id uint32) error {
	windows, err := d.window(id)
	if err != nil {
		return err
	}
	return windows.closeWindow(id)
}

func (d *Display) window(id uint32) (*windowManager, error) {
	if d == nil {
		return nil, errors.New("display unavailable")
	}
	d.mu.Lock()
	valid := false
	if d.state.Ready {
		for _, w := range d.state.Windows {
			if w.ID == id {
				valid = true
				break
			}
		}
	}
	windows := d.windows
	d.mu.Unlock()
	if !valid {
		return nil, errors.New("window not found")
	}
	return windows, nil
}

func (d *Display) Close() {
	if d == nil {
		return
	}
	d.close.Do(func() {
		d.cancel()
		if d.listener != nil {
			d.listener.Close()
		}
		if d.abstract != nil {
			d.abstract.Close()
		}
		d.runtime.Lock()
		d.stop("", nil)
		d.runtime.Unlock()
		d.workers.Wait()
		os.RemoveAll(d.dir)
	})
}
