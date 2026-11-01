package keeper

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"testing"
	"time"
	"tuxee/internal/identity"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

func TestMain(m *testing.M) {
	if path := os.Getenv("TUXEE_KEEPER_TEST_BINARY"); path != "" {
		var err error
		native, err = os.ReadFile(path)
		if err != nil {
			panic(err)
		}
	}
	if len(os.Args) > 1 && os.Args[1] == "__keeper" {
		if err := Worker(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestMalformedRequestsKeepProcesses(t *testing.T) {
	c, job, u, id := fixture(t, "sleep 60")
	null, err := os.OpenFile("/dev/null", os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer null.Close()
	data := binary.BigEndian.AppendUint32(nil, 1)
	data = binary.BigEndian.AppendUint32(data, 0)
	data = append(data, []byte("/bin/true\x00")...)
	for _, slot := range []uint64{0, 8, 1<<32 + 2, ^uint64(0)} {
		if _, err = c.call(opSpawn, slot, 0, data, null, null, null, null); err != unix.EINVAL {
			t.Fatalf("spawn slot %d: %v", slot, err)
		}
	}
	before, err := os.ReadDir(fmt.Sprintf("/proc/%d/fd", c.peerPID))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 100; i++ {
		if _, err = c.call(opPut, 999, 0, nil, null); err != unix.EINVAL {
			t.Fatal(err)
		}
	}
	after, err := os.ReadDir(fmt.Sprintf("/proc/%d/fd", c.peerPID))
	if err != nil || len(before) != len(after) {
		t.Fatalf("descriptor leak: %d -> %d: %v", len(before), len(after), err)
	}
	for _, size := range []int{1, headerSize - 1, headerSize, headerSize + maxPayload + 1} {
		request := make([]byte, size)
		if size >= headerSize {
			binary.BigEndian.PutUint32(request, magic)
			binary.BigEndian.PutUint32(request[4:], opInput)
			binary.BigEndian.PutUint32(request[8:], uint32(size-headerSize+1))
		}
		if _, _, err = c.conn.WriteMsgUnix(request, nil, nil); err != nil {
			t.Fatal(err)
		}
		if _, err = receive(c.conn); err != unix.EPROTO {
			t.Fatal(err)
		}
		c.Close()
		c, err = Connect(u, id, "test")
		if err != nil {
			t.Fatal(err)
		}
		current, exited, e := c.Job(1)
		if e != nil || exited || current.PID != job.PID {
			t.Fatal("malformed request killed shell", e)
		}
	}
	defer c.Close()
	defer c.Stop()
}

func TestGuardianDeathWakesWaiters(t *testing.T) {
	c, job, _, _ := fixture(t, "sleep 60")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: t.TempDir() + "/listener", Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	f, err := listener.File()
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err = c.Put(2, f); err != nil {
		t.Fatal(err)
	}
	jobDone, acceptDone := make(chan error, 1), make(chan error, 1)
	go func() { jobDone <- job.Wait() }()
	go func() { _, err := c.Accept(ctx, 2); acceptDone <- err }()
	// Both waiters must already be asleep when the guardian disappears.
	time.Sleep(100 * time.Millisecond)
	wake := c.Changed()
	if err = unix.Kill(c.peerPID, unix.SIGKILL); err != nil {
		t.Fatal(err)
	}
	for _, done := range []<-chan error{jobDone, acceptDone} {
		select {
		case err := <-done:
			if err == nil {
				t.Error("guardian death reported success")
			}
		case <-time.After(3 * time.Second):
			t.Error("guardian death did not wake a waiter")
		}
	}
	select {
	case <-wake:
	default:
		t.Error("guardian death did not wake output reader")
	}
}

func fixture(t testing.TB, script string) (*Client, *Job, identity.User, string) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("credential-dropped worker requires root")
	}
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	u, err := identity.Lookup(os.Getenv("USER"))
	if err != nil {
		t.Fatal(err)
	}
	id := "012345678901234567890123"
	c, err := Start(u, id, "test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if again, e := Connect(u, id, "test"); e == nil {
			again.Stop()
			again.Close()
		} else {
			c.Stop()
			c.Close()
		}
	})
	master, slave, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer master.Close()
	defer slave.Close()
	if err = c.PTY(master); err != nil {
		t.Fatal(err)
	}
	cwd, err := os.Open(u.Home)
	if err != nil {
		t.Fatal(err)
	}
	defer cwd.Close()
	cmd := u.Command(context.Background(), "/bin/sh", "-c", script)
	j, err := c.Spawn(1, cmd.Args, cmd.Env, cwd, slave, slave, slave, true)
	if err != nil {
		t.Fatal(err)
	}
	return c, j, u, id
}

func next(t testing.TB, c *Client, offset uint64) Record {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		wake := c.Changed()
		r, err := c.Read(offset)
		if err != nil {
			t.Fatal(err)
		}
		if r.Kind != 0 {
			return r
		}
		select {
		case <-wake:
		case <-deadline:
			t.Fatal("journal timed out")
		}
	}
}

func TestRecoveryAndQueryDeduplication(t *testing.T) {
	c, j, u, id := fixture(t, "stty -echo -icanon; printf READY; cat")
	var offset uint64
	var got []byte
	for !bytes.Contains(got, []byte("READY")) {
		r := next(t, c, offset)
		offset = r.Offset
		got = append(got, r.Data...)
	}
	if err := c.Commit(offset-1, []byte("partial record")); err != unix.EINVAL {
		t.Fatalf("accepted partial journal checkpoint: %v", err)
	}
	if err := c.Commit(offset, []byte("opaque state")); err != nil {
		t.Fatal(err)
	}
	if err := c.Input([]byte("one"), offset); err != nil {
		t.Fatal(err)
	}
	r := next(t, c, offset)
	if string(r.Data) != "one" {
		t.Fatalf("output %q", r.Data)
	}
	c.Close()
	c, err := Connect(u, id, "test")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	defer c.Stop()
	if c.Head != offset {
		t.Fatalf("checkpoint offset %d != %d", c.Head, offset)
	}
	state, err := c.Load(0, 100)
	if err != nil || string(state) != "opaque state" {
		t.Fatalf("checkpoint %q %v", state, err)
	}
	job, exited, err := c.Job(1)
	if err != nil || exited || job.PID != j.PID {
		t.Fatalf("changed process: %#v %v %v", job, exited, err)
	}
	replayed := next(t, c, offset)
	if !bytes.Equal(replayed.Data, r.Data) || replayed.Offset != r.Offset {
		t.Fatal("lost output during detach")
	}
	if err = c.Input([]byte("one"), offset); err != nil {
		t.Fatal(err)
	}
	if err = c.Input([]byte("two"), 0); err != nil {
		t.Fatal(err)
	}
	r = next(t, c, r.Offset)
	if string(r.Data) != "two" {
		t.Fatalf("replayed query reply: %q", r.Data)
	}
	if _, err = c.call(999, 0, 0, nil); err != unix.ENOSYS {
		t.Fatalf("unknown operation: %v", err)
	}
	if _, _, err = c.Job(1); err != nil {
		t.Fatal("unknown request killed guardian", err)
	}
}

func TestBackpressureAndFinalOutput(t *testing.T) {
	c, j, _, _ := fixture(t, "stty -opost; head -c 8388608 /dev/zero; printf FINAL")
	defer c.Close()
	defer c.Stop()
	time.Sleep(100 * time.Millisecond)
	_, exited, err := c.Job(1)
	if err != nil || exited {
		t.Fatalf("producer bypassed bounded journal: %v %v", exited, err)
	}
	var offset uint64
	total := 0
	for {
		r := next(t, c, offset)
		offset = r.Offset
		if r.Kind == End {
			break
		}
		if r.Kind != Output {
			t.Fatal(r.Kind)
		}
		for _, b := range r.Data {
			if total < 8388608 && b != 0 {
				t.Fatal("corrupt byte", total, b)
			}
			total++
		}
		if err = c.Commit(offset, []byte("snapshot")); err != nil {
			t.Fatal(err)
		}
	}
	if total != 8388608+5 {
		t.Fatal("lost output", total)
	}
	if err = j.Wait(); err != nil {
		t.Fatal(err)
	}
}

func TestRelaySurvivesController(t *testing.T) {
	c, _, u, id := fixture(t, "sleep 60")
	defer c.Close()
	pair := func() (*net.UnixConn, *net.UnixConn) {
		fds, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
		if err != nil {
			t.Fatal(err)
		}
		var result [2]*net.UnixConn
		for i, fd := range fds {
			f := os.NewFile(uintptr(fd), "relay")
			conn, e := net.FileConn(f)
			f.Close()
			if e != nil {
				t.Fatal(e)
			}
			result[i] = conn.(*net.UnixConn)
			t.Cleanup(func() { conn.Close() })
		}
		return result[0], result[1]
	}
	a, from := pair()
	b, to := pair()
	if err := c.Relay(a, b); err != nil {
		t.Fatal(err)
	}
	a.Close()
	b.Close()
	c.Close()
	from.SetDeadline(time.Now().Add(5 * time.Second))
	to.SetDeadline(time.Now().Add(5 * time.Second))
	for i := 0; i < 100; i++ {
		data := bytes.Repeat([]byte{byte(i)}, 8192)
		done := make(chan error, 1)
		go func() { _, e := from.Write(data); done <- e }()
		got := make([]byte, len(data))
		if _, err := io.ReadFull(to, got); err != nil {
			t.Fatal(err)
		}
		if err := <-done; err != nil || !bytes.Equal(got, data) {
			t.Fatal("relay corrupted stream", err)
		}
	}
	from.CloseWrite()
	buf := make([]byte, 1)
	if _, err := to.Read(buf); err != io.EOF {
		t.Fatal("half close", err)
	}
	if _, err := to.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(from, buf); err != nil || buf[0] != 'x' {
		t.Fatal("reverse stream after half close", err)
	}
	again, err := Connect(u, id, "test")
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	defer again.Stop()
}

func TestAbandonedReplyKeepsCheckpoint(t *testing.T) {
	c, _, u, id := fixture(t, "sleep 60")
	if err := c.Commit(0, []byte("checkpoint")); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 50; i++ {
		request := make([]byte, headerSize)
		binary.BigEndian.PutUint32(request, magic)
		binary.BigEndian.PutUint32(request[4:], opGet)
		if _, _, err := c.conn.WriteMsgUnix(request, nil, nil); err != nil {
			t.Fatal(err)
		}
		// Closing with unread ancillary data may make the peer's next recvmsg fail.
		time.Sleep(time.Millisecond)
		c.Close()
		var err error
		c, err = Connect(u, id, "test")
		if err != nil {
			t.Fatal(err)
		}
		data, err := c.Load(0, 100)
		if err != nil || string(data) != "checkpoint" {
			t.Fatalf("lost checkpoint on aborted response %d: %q %v", i, data, err)
		}
	}
	defer c.Close()
	defer c.Stop()
}

func TestAcceptedConnectionSurvivesController(t *testing.T) {
	c, _, u, id := fixture(t, "sleep 60")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: t.TempDir() + "/listener", Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	f, err := listener.File()
	if err != nil {
		t.Fatal(err)
	}
	err = c.Put(2, f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	peer, err := net.DialUnix("unix", nil, listener.Addr().(*net.UnixAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	accepted, err := c.Accept(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = peer.Write([]byte("survived")); err != nil {
		t.Fatal(err)
	}
	accepted.Close()
	c.Close()
	c, err = Connect(u, id, "test")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	defer c.Stop()
	accepted, err = c.Accept(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer accepted.Close()
	accepted.SetReadDeadline(time.Now().Add(time.Second))
	data := make([]byte, 8)
	if _, err = io.ReadFull(accepted, data); err != nil || string(data) != "survived" {
		t.Fatalf("accepted stream lost: %q %v", data, err)
	}
	if err = c.Reject(2); err != nil {
		t.Fatal(err)
	}
}

func TestJobOwnedLifetimeWithoutController(t *testing.T) {
	c, job, u, _ := fixture(t, "sleep 60")
	shared, err := Start(u, "audio", "test")
	if err != nil {
		t.Fatal(err)
	}
	defer shared.Close()
	defer shared.Stop()
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = c.PutOwned(5, 1, write); err != nil {
		t.Fatal(err)
	}
	if err = shared.Track(read); err != nil {
		t.Fatal(err)
	}
	read.Close()
	write.Close()
	c.Close()
	if err = unix.Kill(job.PID, unix.SIGKILL); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err = shared.Load(1, 100); err != nil && err != unix.ENOENT {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("shared guardian stayed alive after last owned reference ended")
}

func BenchmarkPTYRoundTrip(b *testing.B) {
	const command = "stty raw -echo; printf R; cat"
	b.Run("direct", func(b *testing.B) {
		cmd := exec.Command("/bin/sh", "-c", command)
		master, err := pty.Start(cmd)
		if err != nil {
			b.Fatal(err)
		}
		defer master.Close()
		defer func() { unix.Kill(-cmd.Process.Pid, unix.SIGKILL); cmd.Wait() }()
		data := make([]byte, 1)
		if _, err = io.ReadFull(master, data); err != nil {
			b.Fatal(err)
		}
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			if _, err = master.Write(data); err != nil {
				b.Fatal(err)
			}
			if _, err = io.ReadFull(master, data); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("keeper", func(b *testing.B) {
		c, _, _, _ := fixture(b, command)
		defer c.Close()
		defer c.Stop()
		offset := next(b, c, 0).Offset
		data := []byte("R")
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			if err := c.Input(data, 0); err != nil {
				b.Fatal(err)
			}
			offset = next(b, c, offset).Offset
			if i%50000 == 49999 {
				if err := c.Commit(offset, nil); err != nil {
					b.Fatal(err)
				}
			}
		}
	})
}
