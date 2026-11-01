// Package keeper controls versioned native guardians. Closing a Client only detaches.
package keeper

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"runtime"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

const (
	magic      = 0x54584b32
	headerSize = 32
	maxPayload = 65536
	opGet      = 1
	opPut      = 2
	opSpawn    = 3
	opStatus   = 4
	opSignal   = 5
	opRelay    = 6
	opRead     = 7
	opCommit   = 8
	opInput    = 9
	opEvent    = 10
	opPTY      = 11
	opClose    = 12
	opTrack    = 13
	opAccept   = 14
	Output     = 1
	End        = 2
	Resize     = 3
)

type packet struct {
	op       uint32
	arg, aux uint64
	data     []byte
	fds      []*os.File
}

type Client struct {
	conn         *net.UnixConn
	notification *os.File
	monitor      *os.File
	mu           sync.Mutex
	wakeMu       sync.Mutex
	wake         chan struct{}
	closed       bool
	Head, Tail   uint64
	peer         *os.File
	peerPID      int
}

var receiveBuffers = sync.Pool{New: func() any { return new([headerSize + maxPayload]byte) }}

func receive(conn *net.UnixConn) (packet, error) {
	buffer := receiveBuffers.Get().(*[headerSize + maxPayload]byte)
	defer receiveBuffers.Put(buffer)
	data := buffer[:]
	var control [128]byte
	n, oob, flags, _, err := conn.ReadMsgUnix(data, control[:])
	p := packet{}
	if err != nil {
		return p, err
	}
	messages, err := unix.ParseSocketControlMessage(control[:oob])
	if err == nil {
		for _, message := range messages {
			fds, parseErr := unix.ParseUnixRights(&message)
			if parseErr != nil {
				err = parseErr
				break
			}
			for _, fd := range fds {
				unix.CloseOnExec(fd)
				p.fds = append(p.fds, os.NewFile(uintptr(fd), "keeper-fd"))
			}
		}
	}
	if err == nil && (flags&(unix.MSG_TRUNC|unix.MSG_CTRUNC) != 0 || n < headerSize || binary.BigEndian.Uint32(data) != magic || int(binary.BigEndian.Uint32(data[8:])) != n-headerSize) {
		err = errors.New("invalid keeper protocol packet")
	}
	if err == nil {
		p.op = binary.BigEndian.Uint32(data[4:])
		p.arg, p.aux = binary.BigEndian.Uint64(data[16:]), binary.BigEndian.Uint64(data[24:])
		p.data = append([]byte(nil), data[headerSize:n]...)
		if code := binary.BigEndian.Uint32(data[12:]); code != 0 {
			err = unix.Errno(code)
		}
	}
	if err != nil {
		for _, fd := range p.fds {
			fd.Close()
		}
		p.fds = nil
	}
	return p, err
}

func attach(file *os.File) (*Client, error) {
	conn, err := net.FileConn(file)
	if err != nil {
		return nil, err
	}
	socket, ok := conn.(*net.UnixConn)
	if !ok {
		conn.Close()
		return nil, errors.New("keeper connection is not Unix")
	}
	socket.SetReadDeadline(time.Now().Add(5 * time.Second))
	hello, err := receive(socket)
	socket.SetReadDeadline(time.Time{})
	if err == nil && (hello.op != 0x80000000 || len(hello.fds) != 1) {
		err = errors.New("unsupported keeper protocol")
	}
	if err != nil {
		socket.Close()
		for _, fd := range hello.fds {
			fd.Close()
		}
		return nil, err
	}
	c := &Client{conn: socket, notification: hello.fds[0], wake: make(chan struct{}), Head: hello.arg, Tail: hello.aux}
	raw, _ := socket.SyscallConn()
	_ = raw.Control(func(fd uintptr) {
		cred, e := unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
		if e == nil {
			c.peerPID = int(cred.Pid)
		}
		if pidfd, e := unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_PEERPIDFD); e == nil {
			unix.CloseOnExec(pidfd)
			c.peer = os.NewFile(uintptr(pidfd), "keeper-peer")
		}
	})
	if err = c.watch(); err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

func (c *Client) watch() error {
	fd, err := unix.EpollCreate1(unix.EPOLL_CLOEXEC)
	if err != nil {
		return err
	}
	if err = unix.SetNonblock(fd, true); err != nil {
		unix.Close(fd)
		return err
	}
	// An epoll descriptor can itself use Go's poller, without one OS thread per helper.
	c.monitor = os.NewFile(uintptr(fd), "keeper-notifications")
	raw, err := c.conn.SyscallConn()
	if err != nil {
		return err
	}
	if controlErr := raw.Control(func(socket uintptr) {
		err = unix.EpollCtl(fd, unix.EPOLL_CTL_ADD, int(socket), &unix.EpollEvent{Events: unix.EPOLLRDHUP, Fd: 1})
	}); controlErr != nil {
		return controlErr
	}
	if err != nil {
		return err
	}
	raw, err = c.notification.SyscallConn()
	if err != nil {
		return err
	}
	if controlErr := raw.Control(func(notification uintptr) {
		err = unix.EpollCtl(fd, unix.EPOLL_CTL_ADD, int(notification), &unix.EpollEvent{Events: unix.EPOLLIN, Fd: 2})
	}); controlErr != nil {
		return controlErr
	}
	if err != nil {
		return err
	}
	poller, err := c.monitor.SyscallConn()
	if err != nil {
		return err
	}
	go func() {
		var events [2]unix.EpollEvent
		var counter [8]byte
		for {
			var n int
			var waitErr error
			err := poller.Read(func(epoll uintptr) bool {
				for {
					n, waitErr = unix.EpollWait(int(epoll), events[:], 0)
					if waitErr != unix.EINTR {
						break
					}
				}
				return n > 0 || waitErr != nil
			})
			if err == nil {
				err = waitErr
			}
			for _, event := range events[:max(n, 0)] {
				if event.Fd == 1 {
					err = io.EOF
					break
				}
				if _, e := c.notification.Read(counter[:]); e != nil {
					err = e
				}
			}
			c.wakeMu.Lock()
			if c.closed {
				c.wakeMu.Unlock()
				return
			}
			close(c.wake)
			if err != nil {
				c.closed = true
				c.wakeMu.Unlock()
				return
			}
			c.wake = make(chan struct{})
			c.wakeMu.Unlock()
		}
	}()
	return nil
}

func (c *Client) Changed() <-chan struct{} { c.wakeMu.Lock(); defer c.wakeMu.Unlock(); return c.wake }

func (c *Client) call(op uint32, arg, aux uint64, data []byte, files ...*os.File) (packet, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(data) > maxPayload || len(files) > 4 {
		return packet{}, errors.New("keeper request too large")
	}
	h := make([]byte, headerSize+len(data))
	binary.BigEndian.PutUint32(h, magic)
	binary.BigEndian.PutUint32(h[4:], op)
	binary.BigEndian.PutUint32(h[8:], uint32(len(data)))
	binary.BigEndian.PutUint64(h[16:], arg)
	binary.BigEndian.PutUint64(h[24:], aux)
	copy(h[headerSize:], data)
	var control []byte
	if len(files) > 0 {
		fds := make([]int, len(files))
		for i, file := range files {
			// File.Fd switches network descriptors to blocking mode, including their duplicates.
			raw, err := file.SyscallConn()
			if err != nil {
				return packet{}, err
			}
			if err = raw.Control(func(fd uintptr) { fds[i] = int(fd) }); err != nil {
				return packet{}, err
			}
		}
		control = unix.UnixRights(fds...)
	}
	c.conn.SetDeadline(time.Now().Add(5 * time.Second))
	defer c.conn.SetDeadline(time.Time{})
	if _, _, err := c.conn.WriteMsgUnix(h, control, nil); err != nil {
		return packet{}, err
	}
	runtime.KeepAlive(files)
	p, err := receive(c.conn)
	if err == nil && p.op != op|0x80000000 {
		err = errors.New("unexpected keeper response")
		for _, f := range p.fds {
			f.Close()
		}
		p.fds = nil
	}
	return p, err
}

func (c *Client) Close() error {
	if c.monitor != nil {
		c.monitor.Close()
	}
	if c.peer != nil {
		c.peer.Close()
	}
	c.notification.Close()
	return c.conn.Close()
}
func (c *Client) Stop() error {
	_, err := c.call(opClose, 0, 0, nil)
	if err != nil && os.Geteuid() == 0 && c.peer != nil {
		err = c.finishCleanup()
	}
	if err == nil {
		c.Close()
	}
	return err
}
func (c *Client) PTY(master *os.File) error { _, err := c.call(opPTY, 0, 0, nil, master); return err }
func (c *Client) Put(slot uint64, file *os.File) error {
	return c.PutOwned(slot, 0, file)
}

func (c *Client) PutOwned(slot, job uint64, file *os.File) error {
	var fds []*os.File
	if file != nil {
		fds = []*os.File{file}
	}
	_, err := c.call(opPut, slot, job, nil, fds...)
	return err
}

func (c *Client) Track(file *os.File) error { _, err := c.call(opTrack, 0, 0, nil, file); return err }
func (c *Client) Get(slot uint64) (*os.File, error) {
	p, err := c.call(opGet, slot, 0, nil)
	if err != nil {
		return nil, err
	}
	if len(p.fds) != 1 {
		for _, fd := range p.fds {
			fd.Close()
		}
		return nil, errors.New("missing keeper descriptor")
	}
	return p.fds[0], nil
}

func sealed(data []byte) (*os.File, error) {
	fd, err := unix.MemfdCreate("tuxee-checkpoint", unix.MFD_CLOEXEC|unix.MFD_ALLOW_SEALING)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), "checkpoint")
	if _, err = f.Write(data); err == nil {
		_, err = unix.FcntlInt(f.Fd(), unix.F_ADD_SEALS, unix.F_SEAL_WRITE|unix.F_SEAL_GROW|unix.F_SEAL_SHRINK|unix.F_SEAL_SEAL)
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}
func (c *Client) Save(slot uint64, data []byte) error {
	f, err := sealed(data)
	if err != nil {
		return err
	}
	defer f.Close()
	return c.Put(slot, f)
}
func (c *Client) Load(slot uint64, limit int64) ([]byte, error) {
	f, err := c.Get(slot)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errors.New("invalid keeper checkpoint size")
	}
	return io.ReadAll(io.NewSectionReader(f, 0, limit+1))
}
func (c *Client) Commit(offset uint64, data []byte) error {
	f, err := sealed(data)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = c.call(opCommit, offset, 0, nil, f)
	return err
}
func (c *Client) Input(data []byte, replyOffset uint64) error {
	_, err := c.call(opInput, replyOffset, 0, data)
	return err
}
func (c *Client) Event(kind uint32, data []byte) (uint64, error) {
	p, err := c.call(opEvent, uint64(kind), 0, data)
	return p.arg, err
}

type Record struct {
	Offset uint64
	Kind   uint32
	Data   []byte
}

func (c *Client) Read(offset uint64) (Record, error) {
	p, err := c.call(opRead, offset, 0, nil)
	r := Record{Offset: p.arg}
	if err != nil {
		return r, err
	}
	if len(p.data) == 0 {
		return r, nil
	}
	if len(p.data) < 8 || int(binary.BigEndian.Uint32(p.data[4:])) != len(p.data)-8 {
		return r, errors.New("invalid keeper journal record")
	}
	r.Kind = binary.BigEndian.Uint32(p.data)
	r.Data = p.data[8:]
	return r, nil
}
func (c *Client) Relay(a, b *net.UnixConn) error {
	return c.RelayAccepted(0, a, b)
}

func (c *Client) RelayAccepted(slot uint64, a, b *net.UnixConn) error {
	fa, err := a.File()
	if err != nil {
		return err
	}
	defer fa.Close()
	fb, err := b.File()
	if err != nil {
		return err
	}
	defer fb.Close()
	_, err = c.call(opRelay, slot, 0, nil, fa, fb)
	return err
}

func (c *Client) Reject(slot uint64) error { _, err := c.call(opAccept, slot, 1, nil); return err }

// Accept retains the accepted stream in the guardian until RelayAccepted or Reject.
func (c *Client) Accept(ctx context.Context, slot uint64) (*net.UnixConn, error) {
	for {
		wake := c.Changed()
		p, err := c.call(opAccept, slot, 0, nil)
		if err == unix.EAGAIN {
			select {
			case <-wake:
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		if err != nil {
			return nil, err
		}
		if len(p.fds) != 1 {
			for _, f := range p.fds {
				f.Close()
			}
			return nil, errors.New("missing accepted descriptor")
		}
		conn, err := net.FileConn(p.fds[0])
		p.fds[0].Close()
		if err != nil {
			return nil, err
		}
		stream, ok := conn.(*net.UnixConn)
		if !ok {
			conn.Close()
			return nil, errors.New("invalid accepted stream")
		}
		return stream, nil
	}
}

type Job struct {
	Client *Client
	Slot   uint64
	PID    int
}

func (c *Client) Job(slot uint64) (*Job, bool, error) {
	p, err := c.call(opStatus, slot, 0, nil)
	if err != nil {
		return nil, false, err
	}
	return &Job{c, slot, int(p.arg)}, p.aux>>32 != 0, nil
}
func (j *Job) Signal(signal unix.Signal) error {
	_, err := j.Client.call(opSignal, j.Slot, uint64(signal), nil)
	return err
}
func (j *Job) Wait() error {
	for {
		wake := j.Client.Changed()
		p, err := j.Client.call(opStatus, j.Slot, 0, nil)
		if err != nil {
			return err
		}
		if int(p.arg) != j.PID {
			return errors.New("keeper job replaced")
		}
		if p.aux>>32 != 0 {
			if uint32(p.aux) != 0 {
				return fmt.Errorf("job exit status %d", uint32(p.aux))
			}
			return nil
		}
		<-wake
	}
}
func (c *Client) Spawn(slot uint64, argv, env []string, cwd, stdin, stdout, stderr *os.File, tty bool) (*Job, error) {
	data := make([]byte, 8)
	binary.BigEndian.PutUint32(data, uint32(len(argv)))
	binary.BigEndian.PutUint32(data[4:], uint32(len(env)))
	for _, list := range [][]string{argv, env} {
		for _, value := range list {
			for _, b := range value {
				if b == 0 {
					return nil, errors.New("NUL in process argument")
				}
			}
			data = append(data, value...)
			data = append(data, 0)
		}
	}
	flags := uint64(0)
	if tty {
		flags = 1
	}
	p, err := c.call(opSpawn, slot, flags, data, cwd, stdin, stdout, stderr)
	if err != nil {
		return nil, err
	}
	return &Job{c, slot, int(p.arg)}, nil
}
